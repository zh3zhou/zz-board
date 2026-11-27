import type { CanvasNodeRecord, HumanAction, SnapshotThread } from './schema.js';

const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

export function taskNodeId(threadKey: string): string {
  return `task:${threadKey}`;
}

export function projectNodeId(projectKey: string): string {
  return `project:${projectKey}`;
}

export function initialTaskPosition(index: number): { x: number; y: number } {
  const radius = 70 + Math.sqrt(Math.max(0, index)) * 205;
  const angle = index * GOLDEN_ANGLE - Math.PI / 2;
  return {
    x: Math.round(Math.cos(angle) * radius),
    y: Math.round(Math.sin(angle) * radius)
  };
}

interface RectLike {
  x: number;
  y: number;
  width: number;
  height: number;
}

function overlaps(a: RectLike, b: RectLike, gap = 28): boolean {
  return !(
    a.x + a.width + gap < b.x ||
    b.x + b.width + gap < a.x ||
    a.y + a.height + gap < b.y ||
    b.y + b.height + gap < a.y
  );
}

export function findInboxPosition(existing: RectLike[], width = 180, height = 180, origin = { x: -720, y: -360 }): { x: number; y: number } {
  const step = 220;
  for (let ring = 0; ring < 80; ring += 1) {
    const candidates = ring === 0 ? [[0, 0]] : squareRing(ring);
    for (const [column, row] of candidates) {
      const candidate = { x: origin.x + column * step, y: origin.y + row * step, width, height };
      if (!existing.some((node) => overlaps(candidate, node))) {
        return { x: candidate.x, y: candidate.y };
      }
    }
  }
  return { x: origin.x, y: origin.y + existing.length * 24 };
}

function squareRing(ring: number): Array<[number, number]> {
  const points: Array<[number, number]> = [];
  for (let x = -ring; x <= ring; x += 1) points.push([x, -ring]);
  for (let y = -ring + 1; y <= ring; y += 1) points.push([ring, y]);
  for (let x = ring - 1; x >= -ring; x -= 1) points.push([x, ring]);
  for (let y = ring - 1; y > -ring; y -= 1) points.push([-ring, y]);
  return points;
}

export type RecencyBand = 'today' | 'week' | 'older' | 'unknown';

export interface VisualSignals {
  running: boolean;
  unseen: boolean;
  action: HumanAction;
  actionRequired: boolean;
  recency: RecencyBand;
  staleRuntime: boolean;
}

export function deriveVisualSignals(
  thread: SnapshotThread,
  lastViewedAt: string | null,
  now = new Date()
): VisualSignals {
  const observed = parseDate(thread.observedAt);
  const updated = parseDate(thread.sourceUpdatedAt ?? thread.observedAt);
  const lastViewed = parseDate(lastViewedAt);
  const ageMs = observed ? now.getTime() - observed.getTime() : Number.POSITIVE_INFINITY;
  const staleRuntime = ageMs > 2 * 60 * 1000;
  const actionRequired = thread.humanAction !== 'none' && thread.humanAction !== 'wait' && thread.humanAction !== 'uncertain';

  return {
    running: thread.runtimeState === 'running' && !staleRuntime,
    unseen: Boolean(updated && (!lastViewed || updated.getTime() > lastViewed.getTime())),
    action: thread.humanAction,
    actionRequired,
    recency: recencyBand(updated, now),
    staleRuntime
  };
}

function parseDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function recencyBand(date: Date | null, now: Date): RecencyBand {
  if (!date) return 'unknown';
  const age = Math.max(0, now.getTime() - date.getTime());
  if (age <= 24 * 60 * 60 * 1000) return 'today';
  if (age <= 7 * 24 * 60 * 60 * 1000) return 'week';
  return 'older';
}

export function spatialNode(node: CanvasNodeRecord): RectLike {
  return { x: node.x, y: node.y, width: node.width, height: node.height };
}
