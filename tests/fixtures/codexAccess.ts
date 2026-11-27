import type { BoardDatabase } from '../../src/server/database.js';

/** Explicit consent for synthetic fixtures; production defaults always stay closed. */
export function grantSyntheticCodexAccess(db: BoardDatabase): void {
  db.saveCodexAccess({ schemaVersion: 1, localRead: true, modelUse: true, decidedAt: '2026-10-11T00:00:00.000Z' });
}
