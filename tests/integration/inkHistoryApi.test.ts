import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/server/app.js';
import { loadConfig } from '../../src/server/config.js';
import { BoardDatabase } from '../../src/server/database.js';

let app: FastifyInstance | undefined;
afterEach(async () => { await app?.close(); app = undefined; });
const headers = { 'x-zz-board-mutation': '1' };

describe('ink and history API', () => {
  it('validates, batches, undoes and redoes ink through deliberate mutation routes', async () => {
    app = await buildApp({ ...loadConfig({}), databasePath: ':memory:', demoMode: false }, { db: new BoardDatabase(':memory:') });
    const input = {
      id: 'ink:api', tool: 'highlighter', points: [{ x: 1, y: 2, pressure: 0.5 }], color: '#ffd23f',
      size: 18, opacity: 0.35, layer: 'foreground', zIndex: 1
    };
    expect((await app.inject({ method: 'POST', url: '/api/ink-strokes', payload: input })).statusCode).toBe(403);
    const created = await app.inject({ method: 'POST', url: '/api/ink-strokes', headers, payload: input });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ id: 'ink:api', tool: 'highlighter', revision: 0 });

    const updated = await app.inject({ method: 'POST', url: '/api/ink-strokes/batch', headers, payload: {
      creates: [], updates: [{ id: 'ink:api', patch: { color: '#abcdef', revision: 0 } }], deletes: []
    } });
    expect(updated.json().updated[0]).toMatchObject({ color: '#abcdef', revision: 1 });
    expect((await app.inject({ method: 'POST', url: '/api/history/undo', headers, payload: {} })).json()).toMatchObject({ canRedo: true });
    expect((await app.inject({ method: 'GET', url: '/api/board' })).json().inkStrokes[0]).toMatchObject({ color: '#ffd23f', revision: 0 });
    await app.inject({ method: 'POST', url: '/api/history/redo', headers, payload: {} });
    expect((await app.inject({ method: 'GET', url: '/api/board' })).json().inkStrokes[0].color).toBe('#abcdef');

    const invalid = await app.inject({ method: 'POST', url: '/api/ink-strokes', headers,
      payload: { ...input, id: 'ink:bad', points: [{ x: 0, y: 0, pressure: 2 }] } });
    expect(invalid.statusCode).toBe(400);
  });

  it('persists strict interaction preferences and histories only global Skin application', async () => {
    app = await buildApp({ ...loadConfig({}), databasePath: ':memory:', demoMode: false }, { db: new BoardDatabase(':memory:') });
    const preferences = {
      penColor: '#111', penSize: 3, highlighterColor: '#ee0', highlighterSize: 16,
      eraserMode: 'whole', lassoMode: 'ink', layer: 'background', paletteCollapsed: true
    };
    const beforeSettings = (await app.inject({ method: 'GET', url: '/api/board' })).json();
    const settings = await app.inject({ method: 'PATCH', url: '/api/settings/interaction', headers,
      payload: { keyBindings: { pen: 'P' }, drawingPreferences: preferences } });
    expect(settings.statusCode).toBe(200);
    expect(settings.json()).toMatchObject({ keyBindings: { pen: 'P' }, drawingPreferences: preferences });
    expect(settings.json().drawingPreferences.highlighterColorSlots).toHaveLength(6);
    expect((await app.inject({ method: 'GET', url: '/api/board' })).json().boardRevision).toBe(beforeSettings.boardRevision + 1);
    expect((await app.inject({ method: 'GET', url: '/api/history/status' })).json().canUndo).toBe(false);

    await app.inject({ method: 'POST', url: '/api/settings/skin', headers,
      payload: { activeSkinRef: 'glass@1/global', components: { background: 'glass@1/background', note: 'paper@2/note' } } });
    expect((await app.inject({ method: 'GET', url: '/api/history/status' })).json()).toMatchObject({ canUndo: true, undoLabel: '应用 Skin 组合' });
    await app.inject({ method: 'POST', url: '/api/history/undo', headers, payload: {} });
    expect((await app.inject({ method: 'GET', url: '/api/board' })).json().settings.activeSkinRef).toBe(beforeSettings.settings.activeSkinRef);

    const invalid = await app.inject({ method: 'PATCH', url: '/api/settings/interaction', headers,
      payload: { drawingPreferences: { ...preferences, eraserMode: 'pixel' } } });
    expect(invalid.statusCode).toBe(400);
    const conflicting = await app.inject({ method: 'PATCH', url: '/api/settings/interaction', headers,
      payload: { keyBindings: { pen: 'P', palette: 'p' } } });
    expect(conflicting.statusCode).toBe(400);
    const reserved = await app.inject({ method: 'PATCH', url: '/api/settings/interaction', headers,
      payload: { keyBindings: { pen: 'Space' } } });
    expect(reserved.statusCode).toBe(400);
  });
});
