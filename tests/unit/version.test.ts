import packageJson from '../../package.json';
import { describe, expect, it } from 'vitest';
import { APP_VERSION, SUPPORTED_SNAPSHOT_VERSIONS } from '../../src/shared/version.js';

describe('public compatibility version', () => {
  it('keeps the web/server version aligned with the package and advertises Snapshot V3', () => {
    expect(APP_VERSION).toBe(packageJson.version);
    expect(SUPPORTED_SNAPSHOT_VERSIONS).toContain(1);
    expect(SUPPORTED_SNAPSHOT_VERSIONS).toContain(2);
    expect(SUPPORTED_SNAPSHOT_VERSIONS).toContain(3);
  });
});
