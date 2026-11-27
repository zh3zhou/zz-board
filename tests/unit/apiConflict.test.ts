import { afterEach, expect, it, vi } from 'vitest';
import { api } from '../../src/web/api.js';

afterEach(() => vi.unstubAllGlobals());
it('preserves conflict current-record evidence for the note writer', async () => {
  const current = { id: 'note:test', body: 'original', revision: 2 };
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'changed', current }), { status: 409 })));
  await expect(api.updateNode('note:test', { body: 'edited', revision: 1 })).rejects.toMatchObject({ status: 409, current });
});
