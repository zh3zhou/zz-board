import { createHash } from 'node:crypto';
import { boardSnapshotSchema, MAX_SNAPSHOT_BYTES, SNAPSHOT_MARKER, type BoardSnapshot } from './schema.js';

export function parseSnapshotText(text: string): BoardSnapshot {
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes > MAX_SNAPSHOT_BYTES) {
    throw new Error(`Snapshot exceeds ${MAX_SNAPSHOT_BYTES} bytes.`);
  }
  const extracted = extractSnapshotPayload(text);
  let data: unknown;
  try {
    data = JSON.parse(extracted);
  } catch {
    throw new Error('Snapshot is not valid JSON.');
  }
  return boardSnapshotSchema.parse(data);
}

export function extractSnapshotPayload(text: string): string {
  const marker = `\`\`\`${SNAPSHOT_MARKER}`;
  const start = text.indexOf(marker);
  if (start < 0) return text.trim();
  const bodyStart = text.indexOf('\n', start + marker.length);
  const end = bodyStart < 0 ? -1 : text.indexOf('\n```', bodyStart + 1);
  if (bodyStart < 0 || end < 0) throw new Error('Snapshot marker is incomplete.');
  return text.slice(bodyStart + 1, end).trim();
}

export function snapshotDigest(snapshot: BoardSnapshot): string {
  return createHash('sha256').update(stableJson(snapshot)).digest('hex');
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
