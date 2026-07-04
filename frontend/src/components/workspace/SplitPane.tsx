import React from 'react';
import { Group, Panel, Separator } from 'react-resizable-panels';

interface SplitPaneProps {
  left: React.ReactNode;
  right: React.ReactNode;
  initialLeftPct?: number;
  /** Called whenever the layout changes (during AND after drag). */
  onLayout?: (layout: { [id: string]: number }) => void;
}

/**
 * Two-pane horizontal split with a draggable divider.
 * Uses react-resizable-panels v4 API (Group / Panel / Separator).
 * Cooperates with an absolutely-positioned SVG overlay (LinkOverlay) by
 * leaving DOM structure clean and exposing the library's layout callback.
 */
export const SplitPane: React.FC<SplitPaneProps> = ({
  left,
  right,
  initialLeftPct = 50,
  onLayout,
}) => {
  return (
    <Group
      orientation="horizontal"
      onLayoutChange={onLayout}
      className="h-full w-full"
    >
      <Panel id="left" defaultSize={`${initialLeftPct}%`} minSize="15%">
        <div className="h-full w-full overflow-hidden">{left}</div>
      </Panel>
      <Separator className="group bg-slate-200 dark:bg-slate-800 hover:bg-indigo-400 dark:hover:bg-indigo-500 transition-colors cursor-col-resize flex items-center justify-center" style={{ width: '6px' }}>
        <div className="w-0.5 h-8 bg-slate-400 dark:bg-slate-600 group-hover:bg-white rounded-full" />
      </Separator>
      <Panel id="right" defaultSize={`${100 - initialLeftPct}%`} minSize="15%">
        <div className="h-full w-full overflow-hidden">{right}</div>
      </Panel>
    </Group>
  );
};
