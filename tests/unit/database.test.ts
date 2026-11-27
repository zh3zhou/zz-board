import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { BoardDatabase, DeletedNoteRequestError } from '../../src/server/database.js';
import { createDemoSnapshot } from '../../src/shared/demo.js';
import type { BoardSnapshotV1 } from '../../src/shared/schema.js';

describe('BoardDatabase', () => {
  it('preserves a pinned V1 theme, V2 mixed component and node skin when reopening an unmarked legacy board', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'zz-skin-upgrade-'));
    const file = path.join(directory, 'board.sqlite');
    let db: BoardDatabase | undefined;
    try {
      db = new BoardDatabase(file);
      const note = db.createNote({ title: '样例', body: '原文', x: 15, y: 11, width: 162, height: 105 });
      db.updateNode(note.id, { skinRef: 'sketch-collage@2.0.0/note', revision: note.revision });
      db.setSkinSettings({ activeSkinRef: 'archive-paper@1.0.0', components: { chrome: 'glass-drift@2.0.0/chrome' } });
      const before = db.getBoard();
      db.close(); db = undefined;
      const legacy = new DatabaseSync(file);
      try { legacy.prepare("DELETE FROM settings WHERE key='appearanceMigrationV05'").run(); } finally { legacy.close(); }
      db = new BoardDatabase(file);
      const reopened = db.getBoard();
      expect(reopened.settings.activeSkinRef).toBe('archive-paper@1.0.0');
      expect(reopened.settings.skinComponents).toEqual(before.settings.skinComponents);
      expect(reopened.nodes).toEqual(before.nodes);
      expect(reopened.historyStatus).toEqual(before.historyStatus);
    } finally { db?.close(); fs.rmSync(directory, { recursive: true, force: true }); }
  });
  it('preserves previously collected fingerprints when upgrading the observation table', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(),'zz-board-observation-'));
    const file = path.join(directory,'board.sqlite');
    try {
      const legacy = new DatabaseSync(file);
      try { legacy.exec("CREATE TABLE sync_sources(thread_key TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, source_updated_at TEXT NOT NULL, evidence_checked_at TEXT NOT NULL); INSERT INTO sync_sources VALUES('synthetic','old-fingerprint','2026-01-01','2026-01-01')"); }
      finally { legacy.close(); }
      const db = new BoardDatabase(file);
      try { expect(db.evidenceIsCurrent('synthetic','old-fingerprint')).toBe(true); } finally { db.close(); }
    } finally { fs.rmSync(directory,{recursive:true,force:true}); }
  });
  it('migrates pre-scale nodes and journal rows without changing content, then persists composition scale', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'zz-board-scale-migration-'));
    const databasePath = path.join(directory, 'board.sqlite');
    let db: BoardDatabase | undefined;
    try {
      db = new BoardDatabase(databasePath);
      const note = db.createNote({ title: '', body: '  中文\n\n原文  ', x: -22, y: 31, width: 210, height: 150 });
      db.updateNode(note.id, { body: '  修改后\n\n正文  ', revision: note.revision });
      const before = db.getBoard().nodes[0]!;
      db.close(); db = undefined;
      const legacy = new DatabaseSync(databasePath);
      try {
        legacy.exec('ALTER TABLE canvas_nodes DROP COLUMN content_scale');
        for (const row of legacy.prepare('SELECT sequence, patch_json FROM operation_journal').all()) {
          const patch = JSON.parse(String(row.patch_json));
          for (const change of patch) if (change.table === 'canvas_nodes') {
            if (change.before) delete change.before.content_scale;
            if (change.after) delete change.after.content_scale;
          }
          legacy.prepare('UPDATE operation_journal SET patch_json=? WHERE sequence=?').run(JSON.stringify(patch), row.sequence!);
        }
      } finally { legacy.close(); }
      db = new BoardDatabase(databasePath);
      expect(db.getBoard().nodes[0]).toEqual(before);
      db.undo(); expect(db.getBoard().nodes[0]).toMatchObject({ body: note.body, contentScale: 1, x: -22, y: 31 });
      db.redo(); expect(db.getBoard().nodes[0]).toEqual(before);
      db.applySelectionAction({ action: 'scale', nodes: [{ id: before.id, revision: before.revision }], ink: [], origin: { x: 0, y: 0 }, factor: 2 });
      const scaled = db.getBoard().nodes[0]!;
      db.close(); db = new BoardDatabase(databasePath);
      expect(db.getBoard().nodes[0]).toEqual(scaled);
      expect(scaled).toMatchObject({ body: before.body, contentScale: 2, x: -44, y: 62, width: 420, height: 300 });
      db.undo(); expect(db.getBoard().nodes[0]).toEqual(before);
      db.redo(); expect(db.getBoard().nodes[0]).toEqual(scaled);
    } finally { db?.close(); fs.rmSync(directory, { recursive: true, force: true }); }
  });

  it('imports idempotently and preserves a moved position', () => {
    const db = new BoardDatabase(':memory:');
    const snapshot = createDemoSnapshot(4, new Date('2026-08-20T00:00:00.000Z'));
    expect(db.importSnapshot(snapshot).tasksCreated).toBe(4);
    const before = db.getBoard().nodes[0];
    db.updateNode(before.id, { x: 432, y: -123, aspectLocked: true, revision: before.revision });
    expect(db.importSnapshot(snapshot).tasksCreated).toBe(0);
    const after = db.getBoard().nodes.find((node) => node.id === before.id)!;
    expect({ x: after.x, y: after.y, aspectLocked: after.aspectLocked }).toEqual({ x: 432, y: -123, aspectLocked: true });
    db.close();
  });

  it('rejects stale revisions', () => {
    const db = new BoardDatabase(':memory:');
    db.importSnapshot(createDemoSnapshot(1));
    const node = db.getBoard().nodes[0];
    db.updateNode(node.id, { x: 1, revision: node.revision });
    expect(() => db.updateNode(node.id, { x: 2, revision: node.revision })).toThrow(/changed/);
    db.close();
  });

  it('updates manual priorities atomically and preserves them across import, archive, restore and restart', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'zz-board-priority-'));
    const databasePath = path.join(directory, 'board.sqlite');
    let db: BoardDatabase | undefined;
    try {
      db = new BoardDatabase(databasePath);
      const snapshot = createDemoSnapshot(1);
      db.importSnapshot(snapshot);
      const task = db.getBoard().nodes.find((node) => node.projectKey === snapshot.projects[0]!.projectKey)!;
      const note = db.createNote({ title: '', body: '优先便签', x: 0, y: 0, width: 210, height: 150 });
      const beforeRevision = db.getBoardRevision();
      const updated = db.setNodePriorities([
        { id: task.id, revision: task.revision, manualPriority: 'p1' },
        { id: note.id, revision: note.revision, manualPriority: 'p2' }
      ]);
      expect(updated.map((node) => node.manualPriority)).toEqual(['p1', 'p2']);
      expect(db.getBoardRevision()).toBe(beforeRevision + 1);
      expect(() => db!.setNodePriorities([
        { id: task.id, revision: updated[0]!.revision, manualPriority: 'p3' },
        { id: note.id, revision: note.revision, manualPriority: null }
      ])).toThrow(/changed/);
      expect(db.getBoard().nodes.find((node) => node.id === task.id)?.manualPriority).toBe('p1');
      expect(db.getBoard().nodes.find((node) => node.id === note.id)?.manualPriority).toBe('p2');

      db.importSnapshot({ ...snapshot, generatedAt: '2026-09-01T00:00:00.000Z' });
      const archived = db.setNoteArchived(note.id, true, updated[1]!.revision);
      const restored = db.setNoteArchived(note.id, false, archived.revision);
      expect(restored.manualPriority).toBe('p2');
      db.close();
      db = new BoardDatabase(databasePath);
      expect(db.getBoard().nodes.find((node) => node.id === task.id)?.manualPriority).toBe('p1');
      expect(db.getBoard().nodes.find((node) => node.id === note.id)?.manualPriority).toBe('p2');
    } finally {
      db?.close();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('stores portfolio project briefs and deduplicated todos', () => {
    const db = new BoardDatabase(':memory:');
    const snapshot = createDemoSnapshot(16, new Date('2026-08-20T00:00:00.000Z'));
    const result = db.importSnapshot(snapshot);
    const board = db.getBoard();
    expect(result.projectBriefsSeen).toBe(snapshot.projects.length);
    expect(result.todosSeen).toBe(snapshot.todos.length);
    expect(board.projectBriefs).toHaveLength(snapshot.projects.length);
    expect(board.todos.map((todo) => todo.todoKey)).toEqual(snapshot.todos.map((todo) => todo.todoKey));
    db.close();
  });

  it('conservatively derives project briefs and deduplicates identical actions from V1', () => {
    const db = new BoardDatabase(':memory:');
    const current = createDemoSnapshot(9, new Date('2026-08-20T00:00:00.000Z'));
    const duplicated = { ...current.threads[0]!, threadKey: 'demo:duplicate-decision', threadId: 'duplicate-decision' };
    const snapshot: BoardSnapshotV1 = {
      schemaVersion: 1,
      generatedAt: current.generatedAt,
      source: 'review-project-progress',
      coverage: { ...current.coverage, threadsFound: current.threads.length + 1 },
      projects: current.projects,
      threads: [...current.threads, duplicated]
    };
    const result = db.importSnapshot(snapshot);
    const board = db.getBoard();
    const decision = board.todos.find((todo) => todo.sourceThreadKeys.includes('demo:duplicate-decision'));
    expect(result.projectBriefsSeen).toBe(snapshot.projects.length);
    expect(board.projectBriefs).toHaveLength(snapshot.projects.length);
    expect(decision?.sourceThreadKeys).toEqual(['demo:thread-0', 'demo:duplicate-decision']);
    expect(board.todos.filter((todo) => todo.sourceThreadKeys.includes('demo:duplicate-decision'))).toHaveLength(1);
    db.close();
  });

  it('retires todos absent from a later complete portfolio review', () => {
    const db = new BoardDatabase(':memory:');
    const first = { ...createDemoSnapshot(16, new Date('2026-08-20T00:00:00.000Z')), source: 'review-project-progress' as const };
    db.importSnapshot(first);
    const removed = first.todos[0]!;
    const second = {
      ...first,
      generatedAt: '2026-08-21T00:00:00.000Z',
      projectBriefs: first.projectBriefs.map((brief) => ({ ...brief, observedAt: '2026-08-21T00:00:00.000Z' })),
      todos: first.todos.slice(1).map((todo) => ({ ...todo, observedAt: '2026-08-21T00:00:00.000Z' }))
    };
    db.importSnapshot(second);
    expect(db.getBoard().todos.some((todo) => todo.todoKey === removed.todoKey)).toBe(false);
    db.close();
  });

  it('does not invent a V1 todo when unresolved evidence is absent', () => {
    const db = new BoardDatabase(':memory:');
    const current = createDemoSnapshot(1, new Date('2026-08-20T00:00:00.000Z'));
    const snapshot: BoardSnapshotV1 = {
      schemaVersion: 1,
      generatedAt: current.generatedAt,
      source: 'review-project-progress',
      coverage: current.coverage,
      projects: current.projects,
      threads: current.threads.map((thread) => ({ ...thread, evidence: '', actionStrength: 'recommended' }))
    };
    db.importSnapshot(snapshot);
    const board = db.getBoard();
    expect(board.todos).toEqual([]);
    expect(board.projectBriefs).toHaveLength(snapshot.projects.length);
    expect(board.projectBriefs.find((brief) => brief.projectKey === 'demo-project-1')).toMatchObject({
      workState: 'insufficient_evidence', evidenceLevel: 'none', confidence: 'low'
    });
    db.close();
  });

  it('does not add legacy duplicates when a portfolio database is reopened', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'zz-board-v2-'));
    const databasePath = path.join(directory, 'board.sqlite');
    let db: BoardDatabase | undefined;
    try {
      db = new BoardDatabase(databasePath);
      const snapshot = createDemoSnapshot(16, new Date('2026-08-20T00:00:00.000Z'));
      db.importSnapshot(snapshot);
      const expectedKeys = db.getBoard().todos.map((todo) => todo.todoKey);
      db.close();
      db = undefined;

      db = new BoardDatabase(databasePath);
      const reopenedKeys = db.getBoard().todos.map((todo) => todo.todoKey);
      expect(reopenedKeys).toEqual(expectedKeys);
      expect(reopenedKeys.some((key) => key.startsWith('legacy:'))).toBe(false);
    } finally {
      db?.close();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('persists V3 display titles and falls back to the raw title for legacy imports', () => {
    const db = new BoardDatabase(':memory:');
    const current = createDemoSnapshot(1, new Date('2026-08-20T00:00:00.000Z'));
    db.importSnapshot(current);
    expect(db.getBoard().threads[0]).toMatchObject({
      title: current.threads[0]!.title,
      displayTitle: current.threads[0]!.displayTitle
    });

    const legacy = realLegacySnapshot(current.generatedAt, current.coverage);
    db.importSnapshot(legacy);
    const legacyThread = db.getBoard().threads.find((thread) => thread.threadKey === 'real:thread-1');
    expect(legacyThread).toMatchObject({ title: 'Raw legacy task title', displayTitle: 'Raw legacy task title' });
    db.close();
  });

  it('backs up and removes only unambiguous demo data during formal startup', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'zz-board-cleanup-'));
    const databasePath = path.join(directory, 'board.sqlite');
    let db: BoardDatabase | undefined;
    let backup: BoardDatabase | undefined;
    try {
      db = new BoardDatabase(databasePath);
      const demo = createDemoSnapshot(3, new Date('2026-08-20T00:00:00.000Z'));
      db.importSnapshot(demo);
      db.createNote({ title: '', body: '保留我的便签', x: 1, y: 2, width: 210, height: 150 });
      db.importSnapshot(realLegacySnapshot('2026-08-21T00:00:00.000Z', {
        projectsFound: 1, threadsFound: 1, deepRead: 1, fileChecked: 0, truncated: false, inaccessible: []
      }));
      db.close();

      db = new BoardDatabase(databasePath, { cleanupDemoData: true });
      const cleanup = db.startupDemoCleanup;
      expect(cleanup).toMatchObject({ performed: true, projectsRemoved: 8, threadsRemoved: 3, taskNodesRemoved: 11 });
      expect(cleanup.backupPath).toBeTruthy();
      expect(path.parse(cleanup.backupPath!).root).toBe(path.parse(databasePath).root);
      const cleaned = db.getBoard();
      expect(cleaned.projects.map((project) => project.projectKey)).toEqual(['real-project']);
      expect(cleaned.threads.map((thread) => thread.threadKey)).toEqual(['real:thread-1']);
      expect(cleaned.nodes.filter((node) => node.kind === 'note').map((node) => node.body)).toEqual(['保留我的便签']);
      expect(cleaned.nodes.some((node) => node.kind === 'task' && node.threadKey?.startsWith('demo:'))).toBe(false);
      expect(cleaned.nodes.filter((node) => node.projectKey).map((node) => node.projectKey)).toEqual(['real-project']);

      backup = new BoardDatabase(cleanup.backupPath!);
      expect(backup.getBoard().threads.some((thread) => thread.sourceKind === 'demo')).toBe(true);
      expect(backup.getBoard().nodes.some((node) => node.kind === 'note' && node.body === '保留我的便签')).toBe(true);
      backup.close();
      backup = undefined;

      db.close();
      db = new BoardDatabase(databasePath, { cleanupDemoData: true });
      expect(db.startupDemoCleanup.performed).toBe(false);
    } finally {
      backup?.close();
      db?.close();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('increments one board revision per committed mutation and skips duplicate imports', () => {
    const db = new BoardDatabase(':memory:');
    const observed: number[] = [];
    const unsubscribe = db.onMutation((revision) => observed.push(revision));
    const snapshot = createDemoSnapshot(1);
    db.importSnapshot(snapshot);
    db.importSnapshot(snapshot);
    db.createNote({ title: '', body: 'revision', x: 0, y: 0, width: 210, height: 150 });
    expect(db.getBoard().boardRevision).toBe(2);
    expect(observed).toEqual([1, 2]);
    unsubscribe();
    db.close();
  });

  it('creates one project bubble per project, including empty projects, and preserves both layout generations', () => {
    const db = new BoardDatabase(':memory:');
    const first = createDemoSnapshot(3, new Date('2026-08-20T00:00:00.000Z'));
    db.importSnapshot(first);
    const before = db.getBoard();
    const projects = before.nodes.filter((node) => node.projectKey);
    expect(projects).toHaveLength(first.projects.length);
    expect(projects.map((node) => node.id)).toEqual(first.projects.map((project) => `project:${project.projectKey}`));
    expect(projects.every((node) => node.kind === 'task' && node.threadKey === null)).toBe(true);
    const threadNode = before.nodes.find((node) => node.threadKey === first.threads[0]!.threadKey)!;
    const projectNode = projects.find((node) => node.projectKey === first.threads[0]!.projectKey)!;
    expect(projectNode).toMatchObject({ x: threadNode.x, y: threadNode.y, width: threadNode.width, height: threadNode.height });
    const note = db.createNote({ title: '', body: '保留布局及批注', x: 400, y: 500, width: 210, height: 150 });
    const annotation = db.createAnnotation(threadNode.id, '旧对话批注仍然属于这条对话。');
    const link = db.createLink(threadNode.id, note.id, '旧关联');
    db.updateNode(threadNode.id, { x: 777, revision: threadNode.revision });
    const moved = db.updateNode(projectNode.id, { x: 888, y: 999, width: 230, aspectLocked: false, revision: projectNode.revision });
    db.importSnapshot({ ...first, generatedAt: '2026-08-21T00:00:00.000Z' });
    const after = db.getBoard();
    expect(after.nodes.filter((node) => node.projectKey)).toHaveLength(first.projects.length);
    expect(after.nodes.find((node) => node.id === moved.id)).toEqual(moved);
    expect(after.nodes.find((node) => node.id === threadNode.id)?.x).toBe(777);
    expect(after.annotations).toContainEqual(annotation);
    expect(after.links).toContainEqual(link);
    db.close();
  });

  it('adds project and archive columns to an old database without changing notes or old thread attachments', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'zz-board-old-canvas-'));
    const databasePath = path.join(directory, 'board.sqlite');
    let db: BoardDatabase | undefined;
    try {
      const legacy = new DatabaseSync(databasePath);
      legacy.exec(`
        CREATE TABLE projects (project_key TEXT PRIMARY KEY, project_id TEXT, host_id TEXT, name TEXT NOT NULL, cwd TEXT,
          sidebar_index INTEGER, observed_at TEXT NOT NULL);
        CREATE TABLE threads (thread_key TEXT PRIMARY KEY, source_kind TEXT NOT NULL, host_id TEXT, thread_id TEXT NOT NULL,
          project_key TEXT REFERENCES projects(project_key), title TEXT NOT NULL, cwd TEXT, sidebar_index INTEGER,
          observed_at TEXT NOT NULL, source_updated_at TEXT, runtime_state TEXT NOT NULL, work_state TEXT NOT NULL,
          human_action TEXT NOT NULL, action_strength TEXT NOT NULL, stop_point TEXT NOT NULL, evidence TEXT NOT NULL,
          confidence TEXT NOT NULL, last_observed_at TEXT NOT NULL, missing_since TEXT);
        CREATE TABLE canvas_nodes (id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('task','note')),
          thread_key TEXT UNIQUE REFERENCES threads(thread_key), x REAL NOT NULL, y REAL NOT NULL,
          width REAL NOT NULL, height REAL NOT NULL, z_index INTEGER NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL,
          last_viewed_at TEXT, revision INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
        CREATE TABLE annotations (id TEXT PRIMARY KEY, target_node_id TEXT NOT NULL REFERENCES canvas_nodes(id) ON DELETE CASCADE,
          body TEXT NOT NULL, resolved INTEGER NOT NULL, revision INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
        CREATE TABLE local_links (id TEXT PRIMARY KEY, source_node_id TEXT NOT NULL REFERENCES canvas_nodes(id) ON DELETE CASCADE,
          target_node_id TEXT NOT NULL REFERENCES canvas_nodes(id) ON DELETE CASCADE, label TEXT NOT NULL,
          revision INTEGER NOT NULL, created_at TEXT NOT NULL);
        INSERT INTO projects VALUES ('old-project', NULL, NULL, '旧项目', NULL, 0, '2026-08-20T00:00:00.000Z');
        INSERT INTO projects VALUES ('empty-project', NULL, NULL, '无对话项目', NULL, 1, '2026-08-20T00:00:00.000Z');
        INSERT INTO threads VALUES ('old-thread', 'codex', NULL, 'old-thread', 'old-project', '旧对话', NULL, 0,
          '2026-08-20T00:00:00.000Z', NULL, 'idle', 'stage_closed', 'none', 'none', '保留停点', '旧证据', 'medium',
          '2026-08-20T00:00:00.000Z', NULL);
        INSERT INTO canvas_nodes VALUES ('task:old-thread', 'task', 'old-thread', 312, -99, 222, 190, 5,
          '旧对话', '', NULL, 3, '2026-08-19T00:00:00.000Z', '2026-08-20T00:00:00.000Z');
        INSERT INTO canvas_nodes VALUES ('note:legacy', 'note', NULL, -720, -360, 210, 150, 10,
          '保留标题', '保留正文', NULL, 2, '2026-08-19T00:00:00.000Z', '2026-08-20T00:00:00.000Z');
        INSERT INTO annotations VALUES ('old-annotation', 'task:old-thread', '保留批注', 0, 0,
          '2026-08-19T00:00:00.000Z', '2026-08-20T00:00:00.000Z');
        INSERT INTO local_links VALUES ('old-link', 'task:old-thread', 'note:legacy', '保留连线', 0, '2026-08-19T00:00:00.000Z');
      `);
      legacy.close();
      db = new BoardDatabase(databasePath);
      const board = db.getBoard();
      expect(board.nodes.find((node) => node.id === 'project:old-project')).toMatchObject({
        projectKey: 'old-project', threadKey: null, x: 312, y: -99, width: 222, height: 190, zIndex: 5
      });
      expect(board.nodes.find((node) => node.id === 'note:legacy')).toMatchObject({
        title: '保留标题', body: '保留正文', revision: 2, archivedAt: null, projectKey: null, manualPriority: null, aspectLocked: null
      });
      expect(board.settings.activeSkinRef).toBe('ink-constellation@2.0.0');
      expect(board.historyStatus.undoLabel).toBe('升级默认外观为夜墨 2.0');
      db.undo();
      expect(db.getBoard().settings.activeSkinRef).toBeNull();
      db.redo();
      expect(db.getBoard().settings.activeSkinRef).toBe('ink-constellation@2.0.0');
      const empty = board.nodes.find((node) => node.id === 'project:empty-project')!;
      const note = board.nodes.find((node) => node.id === 'note:legacy')!;
      expect(empty.x + empty.width < note.x || note.x + note.width < empty.x ||
        empty.y + empty.height < note.y || note.y + note.height < empty.y).toBe(true);
      expect(board.annotations).toMatchObject([{ id: 'old-annotation', targetNodeId: 'task:old-thread', body: '保留批注' }]);
      expect(board.links).toMatchObject([{ id: 'old-link', sourceNodeId: 'task:old-thread', targetNodeId: 'note:legacy' }]);
      const revision = db.getBoardRevision();
      db.close();
      db = new BoardDatabase(databasePath);
      expect(db.getBoard().nodes.filter((node) => node.projectKey)).toHaveLength(2);
      expect(db.getBoard().annotations).toEqual(board.annotations);
      expect(db.getBoard().links).toEqual(board.links);
      expect(db.getBoardRevision()).toBe(revision);
    } finally {
      db?.close();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('archives and restores notes without losing body, geometry, annotations or links', () => {
    const db = new BoardDatabase(':memory:');
    db.importSnapshot(createDemoSnapshot(1));
    const task = db.getBoard().nodes.find((node) => node.threadKey)!;
    const note = db.createNote({ title: '旧标题', body: '需要稍后再看', x: 123, y: 456, width: 230, height: 180 });
    const annotation = db.createAnnotation(note.id, '便签批注');
    const link = db.createLink(task.id, note.id, '便签连线');
    const revisions: number[] = [];
    db.onMutation((revision) => revisions.push(revision));
    const archived = db.setNoteArchived(note.id, true, note.revision);
    expect(archived).toMatchObject({ ...note, archivedAt: expect.any(String), revision: note.revision + 1, updatedAt: expect.any(String) });
    expect(db.setNoteArchived(note.id, true, archived.revision)).toEqual(archived);
    expect(revisions).toHaveLength(1);
    expect(() => db.setNoteArchived(note.id, false, note.revision)).toThrow(/changed/);
    const restored = db.setNoteArchived(note.id, false, archived.revision);
    expect(restored).toMatchObject({ ...note, archivedAt: null, revision: archived.revision + 1, updatedAt: expect.any(String) });
    expect(db.getBoard().annotations).toEqual([annotation]);
    expect(db.getBoard().links).toEqual([link]);
    expect(revisions).toHaveLength(2);
    expect(() => db.setNoteArchived(task.id, true, task.revision)).toThrow(/Only local notes/);
    expect(() => db.deleteNote(task.id, task.revision)).toThrow(/Only local notes/);
    expect(() => db.deleteNote(note.id, restored.revision)).toThrow(/Archive the note/);
    const rearchived = db.setNoteArchived(note.id, true, restored.revision);
    expect(() => db.deleteNote(note.id, restored.revision)).toThrow(/changed/);
    db.deleteNote(note.id, rearchived.revision);
    expect(db.getBoard().nodes.some((node) => node.id === note.id)).toBe(false);
    expect(db.getBoard().annotations).toEqual([]);
    expect(db.getBoard().links).toEqual([]);
    db.close();
  });

  it('keeps archived notes archived after restart, import and an offline create retry', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'zz-board-note-archive-'));
    const databasePath = path.join(directory, 'board.sqlite');
    let db: BoardDatabase | undefined;
    try {
      db = new BoardDatabase(databasePath);
      const input = { clientRequestId: 'persistent-note-retry', title: '', body: '归档内容', x: 12, y: 34, width: 210, height: 150 };
      const note = db.createNote(input);
      const archived = db.setNoteArchived(note.id, true, note.revision);
      db.close();
      db = new BoardDatabase(databasePath);
      db.importSnapshot(createDemoSnapshot(2));
      expect(db.getBoard().nodes.find((node) => node.id === note.id)).toEqual(archived);
      expect(db.createNote(input)).toEqual(archived);
      expect(db.getBoard().nodes.filter((node) => node.kind === 'note')).toHaveLength(1);
    } finally {
      db?.close();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('never resurrects a permanently deleted request-note and retains only a hashed tombstone across restarts', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'zz-board-deleted-note-'));
    const databasePath = path.join(directory, 'board.sqlite');
    let db: BoardDatabase | undefined;
    try {
      db = new BoardDatabase(databasePath);
      const input = { clientRequestId: 'deleted-offline-request', title: '不留在删除标记中', body: '已删除的正文', x: 12, y: 34, width: 210, height: 150 };
      const note = db.createNote(input);
      expect(() => db!.deleteNote(note.id, note.revision)).toThrow(/Archive the note/);
      expect(db.createNote(input)).toEqual(note);
      const archived = db.setNoteArchived(note.id, true, note.revision);
      expect(() => db!.deleteNote(note.id, note.revision)).toThrow(/changed/);
      const observed: number[] = [];
      db.onMutation((revision) => observed.push(revision));
      const beforeDeletion = db.getBoardRevision();
      db.deleteNote(note.id, archived.revision);
      expect(observed).toEqual([beforeDeletion + 1]);
      expect(() => db!.createNote(input)).toThrow(DeletedNoteRequestError);
      expect(db.getBoardRevision()).toBe(beforeDeletion + 1);
      expect(db.getBoard().nodes.some((node) => node.id === note.id)).toBe(false);
      db.close();
      db = new BoardDatabase(databasePath);
      db.importSnapshot(createDemoSnapshot(2, new Date('2026-08-20T00:00:00.000Z')));
      db.importSnapshot(realLegacySnapshot('2026-08-19T00:00:00.000Z', {
        projectsFound: 1, threadsFound: 1, deepRead: 0, fileChecked: 0, truncated: false, inaccessible: []
      }));
      expect(() => db!.createNote(input)).toThrow(DeletedNoteRequestError);
      expect(db.getBoard().nodes.some((node) => node.id === note.id)).toBe(false);
      const inspection = new DatabaseSync(databasePath, { readOnly: true });
      try {
        expect(inspection.prepare('SELECT * FROM deleted_note_requests').all()).toEqual([{ node_id: note.id }]);
        expect(inspection.prepare('PRAGMA table_info(deleted_note_requests)').all().map((row) => row.name)).toEqual(['node_id']);
        expect(note.id).not.toContain(input.clientRequestId);
      } finally {
        inspection.close();
      }
    } finally {
      db?.close();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});

function realLegacySnapshot(generatedAt: string, coverage: BoardSnapshotV1['coverage']): BoardSnapshotV1 {
  return {
    schemaVersion: 1,
    generatedAt,
    source: 'review-project-progress',
    coverage,
    projects: [{ projectKey: 'real-project', name: '真实项目', sidebarIndex: 0, observedAt: generatedAt }],
    threads: [{
      threadKey: 'real:thread-1', sourceKind: 'codex', threadId: 'thread-1', projectKey: 'real-project',
      title: 'Raw legacy task title', sidebarIndex: 0, observedAt: generatedAt, runtimeState: 'idle',
      workState: 'stage_closed', humanAction: 'none', actionStrength: 'none', stopPoint: '阶段性交付已完成。',
      evidence: 'Synthetic legacy fixture.', confidence: 'high'
    }]
  };
}
