import React, { useEffect, useRef, useState } from 'react';
import { useLinkStore } from '../../store/useLinkStore';

/**
 * Walk up to the nearest scrollable ancestor. Used to clamp the link line's
 * endpoint Y so the line never pokes above the pane's header (or below its
 * footer) when the linked card is scrolled out of view.
 */
function findScrollContainer(el: HTMLElement): HTMLElement {
  let n: HTMLElement | null = el.parentElement;
  while (n) {
    const cs = getComputedStyle(n);
    if (cs.overflowY === 'auto' || cs.overflowY === 'scroll') return n;
    n = n.parentElement;
  }
  return document.documentElement;
}

/**
 * Single SVG overlay that draws ONE Bézier line between the hovered/focused
 * link pair (a tree node and its matching tagger segment).
 *
 * Both sides carry `data-link-key={spanId}` on their root DOM element.
 * On every requestAnimationFrame while a link is active, we read the two
 * getBoundingClientRect()s and update the path. No subscriptions per node.
 */
export const LinkOverlay: React.FC = () => {
  const hoveredKey = useLinkStore(s => s.hoveredKey);
  const focusedKey = useLinkStore(s => s.focusedKey);
  const activeKey = hoveredKey ?? focusedKey;

  const overlayRef = useRef<SVGSVGElement>(null);
  const [path, setPath] = useState<string | null>(null);
  const [color, setColor] = useState<string>('#6366f1');

  useEffect(() => {
    if (activeKey === null) {
      setPath(null);
      return;
    }

    let rafId = 0;
    const tick = () => {
      const nodes = document.querySelectorAll<HTMLElement>(
        `[data-link-key="${activeKey}"]`,
      );
      if (nodes.length >= 2 && overlayRef.current) {
        // Pair each rect with the rect of its scroll container so we can clamp
        // the endpoint Y when a card is scrolled out of view (otherwise the
        // line would extend up past the pane header to the offscreen card).
        const r1 = nodes[0].getBoundingClientRect();
        const r2 = nodes[1].getBoundingClientRect();
        const c1 = findScrollContainer(nodes[0]).getBoundingClientRect();
        const c2 = findScrollContainer(nodes[1]).getBoundingClientRect();
        // Sort by x so the path always goes left → right.
        const [a, aClip, b, bClip] = r1.left < r2.left ? [r1, c1, r2, c2] : [r2, c2, r1, c1];
        const ax = a.right;
        const bx = b.left;
        const clampY = (y: number, clip: DOMRect) => Math.min(Math.max(y, clip.top), clip.bottom);
        const ay = clampY(a.top + a.height / 2, aClip);
        const by = clampY(b.top + b.height / 2, bClip);
        const dx = Math.max(60, (bx - ax) * 0.5);
        setPath(`M ${ax},${ay} C ${ax + dx},${ay} ${bx - dx},${by} ${bx},${by}`);
        // Pick up tag color from a CSS variable if either node sets one.
        const c = (nodes[0].style.getPropertyValue('--link-color') ||
          nodes[1].style.getPropertyValue('--link-color') ||
          '#6366f1').trim();
        setColor(c);
      } else {
        setPath(null);
      }
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [activeKey]);

  return (
    <svg
      ref={overlayRef}
      className="pointer-events-none fixed inset-0 z-30"
      style={{ width: '100vw', height: '100vh' }}
    >
      {path && (
        <path
          d={path}
          stroke={color}
          strokeWidth={2}
          strokeLinecap="round"
          fill="none"
          opacity={0.7}
        />
      )}
    </svg>
  );
};
