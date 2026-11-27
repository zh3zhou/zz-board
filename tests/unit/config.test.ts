import { describe, expect, it } from 'vitest';
import { dataStoreId, loadConfig } from '../../src/server/config.js';

describe('server configuration', () => {
  it('keeps demo content opt-in and exposes the web fallback runtime by default', () => {
    expect(loadConfig({})).toMatchObject({ demoMode: false, runtime: 'web-fallback' });
    expect(loadConfig({ ZZ_BOARD_DEMO: '1', ZZ_BOARD_RUNTIME: 'desktop-sidecar' })).toMatchObject({
      demoMode: true,
      runtime: 'desktop-sidecar'
    });
  });

  it('derives a stable irreversible storage identifier from a normalized absolute path', () => {
    expect(dataStoreId('E:\\SyntheticProject\\board\\.local-data')).toMatch(/^[a-f0-9]{16}$/);
    expect(dataStoreId('E:\\SyntheticProject\\board\\.local-data')).toBe(dataStoreId('e:/syntheticproject/board/.local-data'));
  });
});
