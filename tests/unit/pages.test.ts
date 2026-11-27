import { describe, expect, it } from 'vitest';
import { boardPages, DEFAULT_PAGE_ID, pageId } from '../../src/shared/pages.js';
import { getNoteFoldEligibility } from '../../src/shared/noteFolding.js';
import type { CanvasNodeRecord, LocalLinkRecord } from '../../src/shared/schema.js';

describe('legacy page fallback and page-qualified folding', () => {
  it('normalizes legacy cached boards and records to the original default page', () => {
    const viewport = { x: 5, y: 6, zoom: .8 };
    expect(pageId({})).toBe(DEFAULT_PAGE_ID);
    expect(boardPages({ viewport })[0]).toMatchObject({ id: DEFAULT_PAGE_ID, viewport, archivedAt: null });
  });
  it('does not infer folding ownership from an external page connection', () => {
    const project = { id: 'p', kind: 'task', projectKey: 'project', pageId: 'page:a' } as CanvasNodeRecord;
    const note = { id: 'n', kind: 'note', pageId: 'page:b' } as CanvasNodeRecord;
    const link = { sourceNodeId: 'p', targetNodeId: 'n' } as LocalLinkRecord;
    expect(getNoteFoldEligibility(note.id, [project, note], [link]).parentNodeId).toBeNull();
  });
});
