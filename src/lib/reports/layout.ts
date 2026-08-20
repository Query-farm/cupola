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
