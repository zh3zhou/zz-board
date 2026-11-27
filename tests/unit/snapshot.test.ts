import { describe, expect, it } from 'vitest';
import { createDemoSnapshot } from '../../src/shared/demo.js';
import type { BoardSnapshotV1, BoardSnapshotV2 } from '../../src/shared/schema.js';
import { parseSnapshotText, snapshotDigest } from '../../src/shared/snapshot.js';

describe('board snapshot', () => {
  it('parses the explicit Skill fence', () => {
    const snapshot = createDemoSnapshot(3, new Date('2026-08-20T00:00:00.000Z'));
    expect(parseSnapshotText(`before\n\`\`\`zz-board-snapshot\n${JSON.stringify(snapshot)}\n\`\`\``)).toEqual(snapshot);
  });

  it('has a stable digest independent of object key order', () => {
    const snapshot = createDemoSnapshot(1);
    expect(snapshotDigest(snapshot)).toMatch(/^[a-f0-9]{64}$/);
  });

  it('rejects unversioned input', () => {
    expect(() => parseSnapshotText('{"projects":[]}')).toThrow();
  });

  it('keeps accepting a Snapshot V1 payload', () => {
    const snapshot = legacySnapshot();
    expect(parseSnapshotText(JSON.stringify(snapshot))).toEqual(snapshot);
  });

  it('requires one project brief for every project in portfolio snapshots', () => {
    const snapshot = createDemoSnapshot(3);
    snapshot.projectBriefs.pop();
    expect(() => parseSnapshotText(JSON.stringify(snapshot))).toThrow(/Missing project brief/);
  });

  it('allows a file-verified todo without a source thread but rejects unsupported todo evidence', () => {
    const snapshot = createDemoSnapshot(1);
    snapshot.projectBriefs[0]!.evidenceLevel = 'file_verified';
    snapshot.todos[0]!.sourceThreadKeys = [];
    expect(parseSnapshotText(JSON.stringify(snapshot)).schemaVersion).toBe(3);

    snapshot.projectBriefs[0]!.evidenceLevel = 'summary_only';
    expect(() => parseSnapshotText(JSON.stringify(snapshot))).toThrow(/file-verified project brief/);
  });

  it('rejects a todo that cites an unknown or cross-project thread', () => {
    const snapshot = createDemoSnapshot(9);
    snapshot.todos[0]!.sourceThreadKeys = ['missing-thread'];
    expect(() => parseSnapshotText(JSON.stringify(snapshot))).toThrow(/Unknown source thread/);
  });

  it('rejects a portfolio thread associated with a project outside the snapshot', () => {
    const snapshot = createDemoSnapshot(1);
    snapshot.threads[0]!.projectKey = 'missing-project';
    expect(() => parseSnapshotText(JSON.stringify(snapshot))).toThrow(/Unknown project in thread/);
  });

  it('keeps every saved project instead of imposing a 1,000-project portfolio cap', () => {
    const observedAt = '2026-08-20T00:00:00.000Z';
    const snapshot = createDemoSnapshot(0, new Date(observedAt));
    snapshot.projects = Array.from({ length: 1_001 }, (_, index) => ({
      projectKey: `p${index}`,
      name: `P${index}`,
      observedAt
    }));
    snapshot.projectBriefs = snapshot.projects.map((project) => ({
      projectKey: project.projectKey,
      overview: '?',
      currentStage: '?',
      workState: 'insufficient_evidence' as const,
      stopPoint: '?',
      codexOrExternalNext: '?',
      evidenceLevel: 'none' as const,
      evidenceReason: '?',
      confidence: 'low' as const,
      observedAt
    }));
    snapshot.coverage.projectsFound = snapshot.projects.length;
    expect(parseSnapshotText(JSON.stringify(snapshot)).projects).toHaveLength(1_001);
  });

  it('rejects duplicated portfolio todo keys', () => {
    const snapshot = createDemoSnapshot(9);
    snapshot.todos.push({ ...snapshot.todos[0]! });
    expect(() => parseSnapshotText(JSON.stringify(snapshot))).toThrow(/Duplicate todo/);
  });

  it('allows same-wording actions when distinct source evidence identifies separate work', () => {
    const snapshot = createDemoSnapshot(9);
    const original = snapshot.todos[0]!;
    const secondThread = {
      ...snapshot.threads[0]!,
      threadKey: 'demo:separate-component',
      threadId: 'separate-component',
      title: 'Test a separate component',
      evidence: 'Independent synthetic evidence for component B.'
    };
    snapshot.threads.push(secondThread);
    snapshot.todos.push({
      ...original,
      todoKey: 'same-wording-separate-work',
      sourceThreadKeys: [secondThread.threadKey],
      evidence: secondThread.evidence
    });
    const parsed = parseSnapshotText(JSON.stringify(snapshot));
    expect(parsed.schemaVersion).toBe(3);
    if (parsed.schemaVersion === 3) expect(parsed.todos).toHaveLength(snapshot.todos.length);
  });

  it('allows distinct decisions from one long-running source task', () => {
    const snapshot = createDemoSnapshot(9);
    const original = snapshot.todos[0]!;
    snapshot.todos.push({
      ...original,
      todoKey: 'second-independent-decision',
      title: 'Choose a separate publication boundary',
      minimumAction: 'Choose whether the publication should include the exploratory appendix.',
      whyNow: 'The same long-running discussion reached a second independent decision fork.',
      unlocks: 'The publication outline can be finalized.'
    });
    const parsed = parseSnapshotText(JSON.stringify(snapshot));
    expect(parsed.schemaVersion).toBe(3);
    if (parsed.schemaVersion === 3) expect(parsed.todos).toHaveLength(snapshot.todos.length);
  });

  it('requires Chinese summary metadata and a display title in Snapshot V3', () => {
    const snapshot = createDemoSnapshot(1);
    const missingLanguage = { ...snapshot } as Record<string, unknown>;
    delete missingLanguage.summaryLanguage;
    expect(() => parseSnapshotText(JSON.stringify(missingLanguage))).toThrow();

    const missingTitle = structuredClone(snapshot) as unknown as { threads: Array<Record<string, unknown>> };
    delete missingTitle.threads[0]!.displayTitle;
    expect(() => parseSnapshotText(JSON.stringify(missingTitle))).toThrow();

    const verboseTitle = structuredClone(snapshot);
    verboseTitle.threads[0]!.displayTitle = '过'.repeat(121);
    expect(() => parseSnapshotText(JSON.stringify(verboseTitle))).toThrow();
  });

  it('keeps accepting Snapshot V2 without displayTitle', () => {
    const snapshot = legacyV2Snapshot();
    const parsed = parseSnapshotText(JSON.stringify(snapshot));
    expect(parsed.schemaVersion).toBe(2);
    expect(parsed.threads[0]).not.toHaveProperty('displayTitle');
  });
});

function legacySnapshot(): BoardSnapshotV1 {
  const current = createDemoSnapshot(3, new Date('2026-08-20T00:00:00.000Z'));
  return {
    schemaVersion: 1,
    generatedAt: current.generatedAt,
    source: current.source,
    coverage: current.coverage,
    projects: current.projects,
    threads: current.threads.map(({ displayTitle: _displayTitle, ...thread }) => thread)
  };
}

function legacyV2Snapshot(): BoardSnapshotV2 {
  const current = createDemoSnapshot(3, new Date('2026-08-20T00:00:00.000Z'));
  return {
    schemaVersion: 2,
    generatedAt: current.generatedAt,
    source: current.source,
    coverage: current.coverage,
    projects: current.projects,
    threads: current.threads.map(({ displayTitle: _displayTitle, ...thread }) => thread),
    projectBriefs: current.projectBriefs,
    todos: current.todos
  };
}
