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
