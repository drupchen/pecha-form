import React, { useEffect, useLayoutEffect, useRef } from 'react';

/** A textarea that grows to fit its content so wrapped phonetics never clip.
 *
 *  Shared by the phonetics bench's line editors and the replacements popup's try-it box —
 *  both hold one long romanized line that has to be readable whole. */
export const AutoGrowTextarea: React.FC<React.TextareaHTMLAttributes<HTMLTextAreaElement>> = (props) => {
  const ref = useRef<HTMLTextAreaElement>(null);
  const fit = () => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';               // shrink first so removals also reflow
    // border-box: scrollHeight is content+padding, so add the border (offset − client) back
    // or the last line clips by the border's width.
    el.style.height = `${el.scrollHeight + el.offsetHeight - el.clientHeight}px`;
  };
  // Re-fit whenever the value changes — typing, generation, or language switch all reflow it.
  useLayoutEffect(fit, [props.value]);
  // The first fit can land before webfonts finish loading (the Tibetan/Latin faces swap in and
  // re-wrap the text) or before the flex column reaches its final width — either leaves a line
  // clipped. Re-fit once fonts are ready and on any width change of the box (pane/window resize).
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let alive = true;
    document.fonts?.ready.then(() => { if (alive) fit(); });
    let lastW = el.clientWidth;
    const ro = new ResizeObserver(() => {
      if (el.clientWidth !== lastW) { lastW = el.clientWidth; fit(); }  // width guard: our own
    });                                                                  // height writes can't loop
    ro.observe(el);
    return () => { alive = false; ro.disconnect(); };
  }, []);
  return <textarea ref={ref} {...props} />;
};
