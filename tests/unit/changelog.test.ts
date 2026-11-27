import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { APP_VERSION } from '../../src/shared/version.js';

const report = readFileSync(new URL('../../CHANGELOG.md', import.meta.url), 'utf8');
const entries = report.split(/^## /m).slice(1);

describe('maintained version report', () => {
  it('has exactly one complete entry for the current application version', () => {
    const current = entries.filter((entry) => entry.startsWith(`${APP_VERSION} — `));
    expect(current, 'Update CHANGELOG.md when releasing a new application version.').toHaveLength(1);
    // Candidate source versions must not invent a release date to satisfy this gate.
    expect(current[0].split('\n')[0].trim()).toMatch(/ — (?:\d{4}-\d{2}-\d{2}|Unreleased(?: · Alpha \d+)?)$/);
    for (const field of ['主要变化', '数据/升级', '验证与状态']) {
      expect(current[0], `Current version needs ${field}`).toContain(`- ${field}：`);
    }
  });
  it('keeps a staging section for work that has not been released', () => {
    expect(entries.filter((entry) => entry.startsWith('未发布\n'))).toHaveLength(1);
  });
});
