import { describe, expect, it, vi } from 'vitest';
import {
  BOOK_FAIR_ID, BOOK_FAIR_SOURCES, connectTrialNodes, MAX_TRIAL_IMAGE_BYTES, pastedImage,
  prepareTrialImage, removeTrialNote, seedTrialBoard, trialBoardSchema
} from '../../src/trial/model.js';
import { nextBoardRevision, TrialConflictError } from '../../src/trial/store.js';

describe('browser trial board', () => {
  it('starts with a self-contained book fair example and preserves stored Chinese notes', () => {
    const initial = seedTrialBoard();
    expect(trialBoardSchema.parse(initial)).toEqual(initial);
    expect(initial.links.every(({ source }) => source === BOOK_FAIR_ID)).toBe(true);
    expect(BOOK_FAIR_SOURCES.every(({ title, excerpt }) => title && excerpt)).toBe(true);
    initial.notes[0] = { ...initial.notes[0], body: '待办：明早带上两张纸样', position: { x: -42, y: 127 } };
    expect(trialBoardSchema.parse(JSON.parse(JSON.stringify(initial))).notes[0]).toEqual(initial.notes[0]);
    expect(seedTrialBoard().notes[0].body).not.toEqual(initial.notes[0].body);
  });

  it('adds links between different nodes, preserving one relationship per pair', () => {
    const board = seedTrialBoard();
    expect(connectTrialNodes(board, 'new', 'sample:paper', 'sample:paper')).toBe(board);
    expect(connectTrialNodes(board, 'new', 'sample:paper', BOOK_FAIR_ID)).toBe(board);
    expect(connectTrialNodes(board, 'new', 'sample:paper', 'missing')).toBe(board);
    const linked = connectTrialNodes(board, 'new', 'sample:paper', 'sample:fold');
    expect(linked.links).toHaveLength(board.links.length + 1);
    expect(trialBoardSchema.safeParse(linked).success).toBe(true);
    const removed = removeTrialNote(linked, 'sample:paper');
    expect(removed.links.some(({ source, target }) => source === 'sample:paper' || target === 'sample:paper')).toBe(false);
    expect(trialBoardSchema.safeParse(removed).success).toBe(true);
  });

  it('rejects a stored board with dangling links, repeated IDs or an unsafe ink color', () => {
    const board = seedTrialBoard();
    expect(trialBoardSchema.safeParse({ ...board, notes: board.notes.slice(1) }).success).toBe(false);
    expect(trialBoardSchema.safeParse({ ...board, notes: [...board.notes, board.notes[0]] }).success).toBe(false);
    expect(trialBoardSchema.safeParse({
      ...board,
      strokes: [{
        id: 'temp', tool: 'pen', points: [{ x: 1, y: 3, pressure: 0.5 }], color: 'url(https://example.invalid/pixel)',
        size: 2, opacity: 1, layer: 'foreground', zIndex: 0, revision: 0, createdAt: '', updatedAt: ''
      }]
    }).success).toBe(false);
  });

  it('requires the expected stored revision before replacing the local board', () => {
    const original = seedTrialBoard();
    const anotherTab = nextBoardRevision(original, original);
    expect(anotherTab.revision).toBe(1);
    expect(original.revision).toBe(0);
    expect(() => nextBoardRevision(anotherTab, original)).toThrow(TrialConflictError);
    expect(() => nextBoardRevision(undefined, original)).toThrow(TrialConflictError);
  });
});

describe('browser trial images', () => {
  const pixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aYioAAAAASUVORK5CYII=', 'base64');

  it('stores verified PNG bytes under their recognized type and releases decoded resources', async () => {
    const close = vi.fn();
    const decode = vi.fn(async () => ({ width: 1, height: 1, close }));
    const file = new File([pixel], 'untrusted-name.txt', { type: 'text/plain' });
    const blob = await prepareTrialImage(file, decode);
    expect(blob.type).toBe('image/png');
    expect(Buffer.from(await blob.arrayBuffer())).toEqual(pixel);
    expect(decode).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  });

  it('rejects unsupported bytes, overlarge files and unreadable images', async () => {
    const decode = vi.fn(async () => { throw new Error('decode failed'); });
    await expect(prepareTrialImage(new Blob(['https://example.invalid/photo.jpg']), decode)).rejects.toThrow();
    await expect(prepareTrialImage(new Blob([new Uint8Array(MAX_TRIAL_IMAGE_BYTES + 1)]), decode)).rejects.toThrow('8 MiB');
    expect(decode).not.toHaveBeenCalled();
    await expect(prepareTrialImage(new Blob([pixel]), decode)).rejects.toThrow('无法解码');
  });

  it('uses clipboard files directly without following clipboard HTML or URLs', () => {
    const real = new File([pixel], 'paste.png', { type: 'image/png' });
    const getData = vi.fn().mockReturnValue('<img src="https://example.invalid/pixel">');
    const payload = { files: [], items: [], getData };
    expect(pastedImage(payload as unknown as DataTransfer)).toBeUndefined();
    expect(pastedImage({ ...payload, files: [real] } as unknown as DataTransfer)).toBe(real);
    expect(pastedImage({
      ...payload, items: [{ kind: 'file', getAsFile: () => real }]
    } as unknown as DataTransfer)).toBe(real);
    expect(getData).not.toHaveBeenCalled();
  });
});
