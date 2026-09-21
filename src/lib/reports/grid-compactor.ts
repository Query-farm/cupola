import { noCompactor, verticalCompactor, type Compactor, type Layout, type LayoutItem } from "react-grid-layout/core";
import { reportDragLayout } from "./layout";

export interface ReportGridCompactor extends Compactor {
  /** Call from the grid's onDragStart with the layout the drag begins from. */
  startDrag(layout: Layout, blockId: string): void;
  /** Call from the grid's onDragStop, which runs after the final compact(). */
  endDrag(): void;
}

/**
 * The report grid's compactor. Outside a drag it is exactly the compactor the
 * report used before: vertical compaction, or none once the report has groups
 * (their heading rows are gaps vertical compaction would close). During a drag
 * it hands placement to `reportDragLayout`, so a block moved up or down passes
 * its neighbors instead of shoving them ahead of it.
 *
 * `allowOverlap` is what routes the drag here: without it, react-grid-layout's
 * moveElement pushes colliding blocks down before compact() ever runs, which
 * is the behavior being replaced. It is otherwise inert for this grid — only
 * drags and the north/west resize handles (not enabled) consult it.
 */
export function createReportGridCompactor(grouped: boolean, groupOf: (blockId: string) => string | undefined): ReportGridCompactor {
  const base = grouped ? noCompactor : verticalCompactor;
  let drag: { blockId: string; start: LayoutItem[]; placements: Map<string, Map<string, number>> } | null = null;

  return {
    type: base.type,
    allowOverlap: true,
    compact(layout, cols) {
      const session = drag;
      const dragged = session ? layout.find((item) => item.i === session.blockId) : undefined;
      if (!session || !dragged) return base.compact(layout, cols);
      // Pointer moves within one grid cell still compact on every event.
      const key = `${dragged.x},${dragged.y}`;
      let rows = session.placements.get(key);
      if (!rows) {
        rows = new Map(reportDragLayout(session.start, session.blockId, dragged, groupOf).map((item) => [item.i, item.y]));
        session.placements.set(key, rows);
      }
      // Fresh items every time: the grid mutates the dragged item in place.
      return layout.map((item) => ({ ...item, y: rows.get(item.i) ?? item.y, moved: false }));
    },
    startDrag(layout, blockId) {
      // Cloned because the grid mutates the items of its live layout.
      drag = { blockId, start: layout.map((item) => ({ ...item })), placements: new Map() };
    },
    endDrag() {
      drag = null;
    },
  };
}
