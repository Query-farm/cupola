import type { ReportBlock, ReportDocumentV1, ReportLayout } from "./types";

export interface ReportLayoutCollision {
  first: ReportBlock;
  second: ReportBlock;
}

export function reportLayoutsOverlap(a: ReportLayout, b: ReportLayout): boolean {
  return a.x < b.x + b.w
    && a.x + a.w > b.x
    && a.y < b.y + b.h
    && a.y + a.h > b.y;
}

export function reportLayoutCollisions(blocks: ReportBlock[]): ReportLayoutCollision[] {
  const collisions: ReportLayoutCollision[] = [];
  for (let firstIndex = 0; firstIndex < blocks.length; firstIndex++) {
    for (let secondIndex = firstIndex + 1; secondIndex < blocks.length; secondIndex++) {
      const first = blocks[firstIndex];
      const second = blocks[secondIndex];
      if (reportLayoutsOverlap(first.layout, second.layout)) collisions.push({ first, second });
    }
  }
  return collisions;
}

/**
 * Preserve each block's requested column and dimensions while moving colliding
 * blocks downward. A pinned block is placed first so direct resizing keeps the
 * block under edit stationary and reflows its neighbors instead.
 */
export function normalizeReportLayout(report: ReportDocumentV1, pinnedBlockId?: string): ReportDocumentV1 {
  if (report.blocks.length < 2 || reportLayoutCollisions(report.blocks).length === 0) return report;

  const originalIndex = new Map(report.blocks.map((block, index) => [block.id, index]));
  const ordered = [...report.blocks].sort((left, right) => {
    if (left.id === pinnedBlockId) return -1;
    if (right.id === pinnedBlockId) return 1;
    return left.layout.y - right.layout.y
      || left.layout.x - right.layout.x
      || (originalIndex.get(left.id) ?? 0) - (originalIndex.get(right.id) ?? 0);
  });
  const placed: ReportBlock[] = [];
  const layouts = new Map<string, ReportLayout>();

  for (const block of ordered) {
    let layout = { ...block.layout };
    while (true) {
      const collisions = placed.filter((candidate) => reportLayoutsOverlap(layout, candidate.layout));
      if (collisions.length === 0) break;
      layout = { ...layout, y: Math.max(...collisions.map((candidate) => candidate.layout.y + candidate.layout.h)) };
    }
    const normalized = { ...block, layout } as ReportBlock;
    placed.push(normalized);
    layouts.set(block.id, layout);
  }

  return {
    ...report,
    blocks: report.blocks.map((block) => ({ ...block, layout: layouts.get(block.id) ?? block.layout }) as ReportBlock),
  };
}

interface ReflowUnit {
  groupId?: string;
  x: number;
  w: number;
  h: number;
  originalY: number;
  originalIndex: number;
  layouts: Map<string, ReportLayout>;
}

function compactBlocks(blocks: ReportBlock[], originalIndex: Map<string, number>): Map<string, ReportLayout> {
  const placed: ReportBlock[] = [];
  const layouts = new Map<string, ReportLayout>();
  const ordered = [...blocks].sort((left, right) => left.layout.y - right.layout.y
    || left.layout.x - right.layout.x
    || (originalIndex.get(left.id) ?? 0) - (originalIndex.get(right.id) ?? 0));

  for (const block of ordered) {
    let layout = { ...block.layout, y: 0 };
    while (true) {
      const collisions = placed.filter((candidate) => reportLayoutsOverlap(layout, candidate.layout));
      if (collisions.length === 0) break;
      layout = { ...layout, y: Math.max(...collisions.map((candidate) => candidate.layout.y + candidate.layout.h)) };
    }
    placed.push({ ...block, layout } as ReportBlock);
    layouts.set(block.id, layout);
  }

  return layouts;
}

/**
 * Tighten a report vertically while preserving every block's column, width,
 * height, and stable reading order. Groups move as bounded sections so an
 * unrelated block cannot be packed inside a group's visual container. A row
 * is reserved before a stacked group for its floating heading.
 */
export function reflowReportLayout(report: ReportDocumentV1): ReportDocumentV1 {
  if (report.blocks.length === 0) return report;

  const originalIndex = new Map(report.blocks.map((block, index) => [block.id, index]));
  const validGroupIds = new Set((report.groups ?? []).map((group) => group.id));
  const grouped = new Map<string, ReportBlock[]>();
  const units: ReflowUnit[] = [];

  for (const block of report.blocks) {
    if (block.groupId && validGroupIds.has(block.groupId)) {
      const members = grouped.get(block.groupId) ?? [];
      members.push(block);
      grouped.set(block.groupId, members);
      continue;
    }
    units.push({
      x: block.layout.x,
      w: block.layout.w,
      h: block.layout.h,
      originalY: block.layout.y,
      originalIndex: originalIndex.get(block.id) ?? 0,
      layouts: new Map([[block.id, { ...block.layout, y: 0 }]]),
    });
  }

  for (const [groupId, members] of grouped) {
    const layouts = compactBlocks(members, originalIndex);
    const minX = Math.min(...members.map((block) => block.layout.x));
    const maxX = Math.max(...members.map((block) => block.layout.x + block.layout.w));
    const height = Math.max(...members.map((block) => {
      const layout = layouts.get(block.id)!;
      return layout.y + layout.h;
    }));
    units.push({
      groupId,
      x: minX,
      w: maxX - minX,
      h: height,
      originalY: Math.min(...members.map((block) => block.layout.y)),
      originalIndex: Math.min(...members.map((block) => originalIndex.get(block.id) ?? 0)),
      layouts,
    });
  }

  units.sort((left, right) => left.originalY - right.originalY
    || left.x - right.x
    || left.originalIndex - right.originalIndex);

  const placedUnits: Array<ReflowUnit & { y: number }> = [];
  const reflowedLayouts = new Map<string, ReportLayout>();
  for (const unit of units) {
    let y = 0;
    while (true) {
      const candidate = { x: unit.x, y, w: unit.w, h: unit.h };
      const collisions = placedUnits.filter((placed) => reportLayoutsOverlap(candidate, placed));
      if (collisions.length === 0) break;
      const headingGutter = unit.groupId ? 1 : 0;
      y = Math.max(...collisions.map((placed) => placed.y + placed.h + headingGutter));
    }
    placedUnits.push({ ...unit, y });
    for (const [blockId, layout] of unit.layouts) {
      reflowedLayouts.set(blockId, { ...layout, y: y + layout.y });
    }
  }

  const blocks = report.blocks.map((block) => ({
    ...block,
    layout: reflowedLayouts.get(block.id) ?? block.layout,
  }) as ReportBlock);
  const changed = blocks.some((block, index) => block.layout.y !== report.blocks[index].layout.y);
  return changed ? { ...report, blocks } : report;
}

/** A placed block as the grid hands it over: its block id plus its layout. */
export interface ReportGridItem extends ReportLayout {
  i: string;
}

type GroupOf = (blockId: string) => string | undefined;

function sharesColumns(a: ReportLayout, b: ReportLayout): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x;
}

function readingOrder<T extends ReportGridItem>(items: readonly T[]): T[] {
  return items
    .map((item, index) => ({ item, index }))
    .sort((left, right) => left.item.y - right.item.y || left.item.x - right.item.x || left.index - right.index)
    .map(({ item }) => item);
}

/**
 * The lowest row a block may occupy: just under everything already placed in
 * its columns. Placing blocks in reading order this way never lets a block
 * slip above one that precedes it.
 */
function restingRow(item: ReportGridItem, placed: readonly ReportGridItem[]): { floor: number; beneath: ReportGridItem[] } {
  const beneath = placed.filter((other) => sharesColumns(item, other));
  return { floor: Math.max(0, ...beneath.map((other) => other.y + other.h)), beneath };
}

/**
 * A block that opens a group section below other content needs the row its
 * floating heading occupies. A block resting on a member of its own group is
 * inside the section and needs none.
 */
function headingGutter(item: ReportGridItem, beneath: readonly ReportGridItem[], floor: number, groupOf: GroupOf): number {
  const groupId = groupOf(item.i);
  if (!groupId || floor === 0) return 0;
  return beneath.some((other) => other.y + other.h === floor && groupOf(other.i) === groupId) ? 0 : 1;
}

/**
 * Rows of deliberate space above each block, beyond any heading row. Keeping
 * these lets a drag reorder blocks without also compacting the whole report.
 */
function measureSlack(order: readonly ReportGridItem[], groupOf: GroupOf): Map<string, number> {
  const placed: ReportGridItem[] = [];
  const slack = new Map<string, number>();
  for (const item of order) {
    const { floor, beneath } = restingRow(item, placed);
    slack.set(item.i, item.y - floor - headingGutter(item, beneath, floor, groupOf));
    placed.push(item);
  }
  return slack;
}

function packInOrder(order: readonly ReportGridItem[], slack: ReadonlyMap<string, number>, groupOf: GroupOf): Map<string, number> {
  const placed: ReportGridItem[] = [];
  const rows = new Map<string, number>();
  for (const item of order) {
    const { floor, beneath } = restingRow(item, placed);
    // Slack is negative only when the starting layout lacked a heading row;
    // clamping keeps the block clear of what it rests on either way.
    const y = floor + Math.max(0, headingGutter(item, beneath, floor, groupOf) + (slack.get(item.i) ?? 0));
    placed.push({ ...item, y });
    rows.set(item.i, y);
  }
  return rows;
}

/**
 * Place a dragged block at the reading-order slot nearest the pointer.
 *
 * react-grid-layout resolves a drag by pushing whatever the block touches
 * downward, so a block dragged down shoves its neighbor ahead of it and can
 * never pass it; with vertical compaction it passes only after travelling
 * the neighbor's full height. Instead, every slot in the drag-start reading
 * order is tried, and the dragged block takes whichever lands it closest to
 * the pointer row. It therefore passes a neighbor once the pointer is nearer
 * the far side of it — the midpoint rule of a sortable list. Among slots
 * that land it equally close, the one that moves the other blocks least wins
 * (so a full-width block passing a row of side-by-side blocks does not split
 * the row), then the one nearest its original slot, so nothing flickers.
 *
 * Every other block keeps its column, its reading order, and the space above
 * it (group heading rows are recomputed for the new neighbors), so the result
 * never overlaps and an untouched report is reproduced exactly. The dragged
 * block keeps its own leading space only while it stays in its original slot.
 */
export function reportDragLayout<T extends ReportGridItem>(
  start: readonly T[],
  draggedId: string,
  target: { x: number; y: number },
  groupOf: GroupOf = () => undefined,
): T[] {
  const order = readingOrder(start);
  const startSlot = order.findIndex((item) => item.i === draggedId);
  if (startSlot < 0) return start.map((item) => ({ ...item }));

  const slack = measureSlack(order, groupOf);
  const movedSlack = new Map(slack).set(draggedId, 0);
  const dragged = { ...order[startSlot], x: target.x, y: target.y };
  const others = order.filter((_, index) => index !== startSlot);

  let best: { rows: Map<string, number>; distance: number; disturbance: number; travel: number } | undefined;
  for (let slot = 0; slot <= others.length; slot++) {
    const candidate = [...others.slice(0, slot), dragged, ...others.slice(slot)];
    const rows = packInOrder(candidate, slot === startSlot ? slack : movedSlack, groupOf);
    const distance = Math.abs(rows.get(draggedId)! - target.y);
    const disturbance = others.reduce((sum, item) => sum + Math.abs(rows.get(item.i)! - item.y), 0);
    const travel = Math.abs(slot - startSlot);
    if (!best
      || distance < best.distance
      || (distance === best.distance && (disturbance < best.disturbance
        || (disturbance === best.disturbance && travel < best.travel)))) {
      best = { rows, distance, disturbance, travel };
    }
  }

  return start.map((item) => ({
    ...item,
    ...(item.i === draggedId ? { x: target.x } : {}),
    y: best!.rows.get(item.i) ?? item.y,
  }));
}
