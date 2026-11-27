import { pageViewportSchema } from './pages.js';
import type { Wallpaper, WallpaperPresetSummary } from './wallpaper.js';
import type { CanvasPageRecord } from './pages.js';
import type { PriorityIcons } from './priorityIcons.js';
export type { CanvasPageRecord } from './pages.js';
import { z } from 'zod';
import { noteScheduleSchema } from './notePriority.js';
import { noteDocumentSchema } from './noteDocument.js';
import { conversationNoteSourceSchema } from './conversationNote.js';
import { milestoneSchema } from './milestones.js';

export const runtimeStateSchema = z.enum(['running', 'idle', 'interrupted', 'error', 'unknown']);
export const workStateSchema = z.enum([
  'in_progress',
  'stage_closed',
  'intentionally_closed',
  'waiting_for_user',
  'waiting_external',
  'needs_validation',
  'complete',
  'insufficient_evidence'
]);
export const humanActionSchema = z.enum([
  'test',
  'review',
  'read_learn',
  'decide',
  'provide_material',
  'approve',
  'reply_continue',
  'wait',
  'none',
  'uncertain'
]);
export const actionStrengthSchema = z.enum(['blocking', 'recommended', 'optional', 'none']);
export const confidenceSchema = z.enum(['high', 'medium', 'low']);
export const sourceKindSchema = z.enum(['codex', 'chatgpt', 'remote', 'snapshot', 'demo', 'unknown']);
export const evidenceLevelSchema = z.enum(['deep_read', 'summary_only', 'file_verified', 'runtime_snapshot', 'none']);
export const todoActionKindSchema = z.enum([
  'test',
  'review',
  'read_learn',
  'decide',
  'provide_material',
  'approve',
  'reply_continue',
  'wait'
]);
export const todoStrengthSchema = z.enum(['blocking', 'recommended', 'optional']);
export const manualPrioritySchema = z.enum(['p1', 'p2', 'p3']);
export const inkToolSchema = z.enum(['pen', 'highlighter']);
export const inkLayerSchema = z.enum(['background', 'foreground']);
export const skinRefSchema = z.string().trim().min(1).max(300);
export const skinComponentKeySchema = z.enum(['background', 'chrome', 'taskBubble', 'note', 'link', 'inkPalette']);
export const skinComponentsSchema = z.object({
  background: skinRefSchema.optional(),
  chrome: skinRefSchema.optional(),
  taskBubble: skinRefSchema.optional(),
  note: skinRefSchema.optional(),
  link: skinRefSchema.optional(),
  inkPalette: skinRefSchema.optional()
}).strict();
export type SkinComponents = Partial<Record<z.infer<typeof skinComponentKeySchema>, string>>;

const boundedText = (max: number) => z.string().trim().max(max);

// Recaps preserve source identity separately from transient conversation text.
export const evidenceSourceSchema = z.object({
  id: boundedText(700).min(1), role: z.enum(['user', 'assistant', 'file']),
  occurredAt: boundedText(80).min(1), turnId: boundedText(400).nullable(), path: boundedText(1500).nullable()
}).strict();
const sourceRefs = z.array(boundedText(700).min(1)).min(1).max(12);
export const threadSummarySchema = z.object({
  headline: boundedText(240).min(1), stopPoint: boundedText(1500).min(1), stopPointRefs: sourceRefs,
  workState: workStateSchema, confidence: confidenceSchema,
  achievements: z.array(z.object({
    id: boundedText(120).min(1), title: boundedText(180).min(1), detail: boundedText(700),
    occurredAt: boundedText(80).min(1), sourceRefs, artifactIds: z.array(boundedText(120)).max(8)
  }).strict()).max(30),
  artifacts: z.array(z.object({ id: boundedText(120).min(1), label: boundedText(180).min(1), uri: boundedText(1500).min(1), sourceRefs }).strict()).max(30),
  versions: z.array(z.object({ version: boundedText(80).min(1), stage: z.enum(['source', 'built', 'running']), sourceRefs }).strict()).max(12),
  milestones: z.array(milestoneSchema).max(24).optional(),
  nextStep: z.object({
    text: boundedText(700).min(1), kind: todoActionKindSchema, strength: z.enum(['blocking', 'recommended']),
    origin: z.enum(['user_request', 'accepted_plan', 'explicit_handoff']), sourceRefs
  }).strict().nullable(),
  nextStepReason: z.enum(['explicit', 'not_stated', 'intentionally_closed', 'insufficient_evidence']),
  resolvedTodos: z.array(z.object({ todoKey: boundedText(700).min(1), sourceRefs }).strict()).max(30)
}).strict().superRefine((value, ctx) => {
  if (Boolean(value.nextStep) !== (value.nextStepReason === 'explicit')) ctx.addIssue({ code: 'custom', message: 'Explicit next step and reason must agree.' });
  if (value.nextStep === null && value.workState === 'waiting_for_user') ctx.addIssue({ code: 'custom', message: 'Waiting for user requires an explicit next step.' });
  const ids = new Set(value.artifacts.map(a => a.id));
  if (ids.size !== value.artifacts.length || new Set(value.achievements.map(a => a.id)).size !== value.achievements.length) ctx.addIssue({ code: 'custom', message: 'Duplicate recap item id.' });
  for (const a of value.achievements) if (a.artifactIds.some(id => !ids.has(id))) ctx.addIssue({ code: 'custom', message: 'Unknown artifact reference.' });
});
export const threadRecapSchema = z.object({
  summary: threadSummarySchema, sources: z.array(evidenceSourceSchema).max(300),
  sourceFingerprint: z.string().regex(/^[a-f0-9]{64}$/), evidenceCheckedAt: boundedText(80).min(1),
  summarizedAt: boundedText(80).min(1), promptVersion: boundedText(80).min(1), model: boundedText(120).min(1), effort: boundedText(40).min(1)
}).strict().superRefine((recap, ctx) => {
  const ids = new Set(recap.sources.map(s => s.id));
  if (ids.size !== recap.sources.length) ctx.addIssue({ code: 'custom', message: 'Duplicate source id.' });
  const s = recap.summary;
  const refs = [...s.stopPointRefs, ...s.achievements.flatMap(a => a.sourceRefs), ...s.artifacts.flatMap(a => a.sourceRefs), ...s.versions.flatMap(v => v.sourceRefs), ...(s.milestones ?? []).flatMap(m => m.sourceRefs), ...(s.nextStep?.sourceRefs ?? []), ...s.resolvedTodos.flatMap(t => t.sourceRefs)];
  if (refs.some(id => !ids.has(id))) ctx.addIssue({ code: 'custom', message: 'Unknown evidence reference.' });
});
export type ThreadSummary = z.infer<typeof threadSummarySchema>;
export type ThreadRecap = z.infer<typeof threadRecapSchema>;

export const snapshotProjectSchema = z
  .object({
    projectKey: boundedText(300),
    projectId: boundedText(300).optional(),
    hostId: boundedText(300).optional(),
    name: boundedText(300),
    cwd: boundedText(1_500).optional(),
    sidebarIndex: z.number().int().nonnegative().optional(),
    observedAt: boundedText(80)
  })
  .strict();

export const snapshotThreadSchema = z
  .object({
    threadKey: boundedText(700),
    sourceKind: sourceKindSchema,
    hostId: boundedText(300).optional(),
    threadId: boundedText(400),
    projectKey: boundedText(300).optional(),
    title: boundedText(500),
    displayTitle: boundedText(500).min(1).optional(),
    cwd: boundedText(1_500).optional(),
    sidebarIndex: z.number().int().nonnegative().optional(),
    observedAt: boundedText(80),
    sourceUpdatedAt: boundedText(80).optional(),
    runtimeState: runtimeStateSchema.default('unknown'),
    workState: workStateSchema.default('insufficient_evidence'),
    humanAction: humanActionSchema.default('uncertain'),
    actionStrength: actionStrengthSchema.default('none'),
    stopPoint: boundedText(1_500).default(''),
    evidence: boundedText(1_500).default(''),
    confidence: confidenceSchema.default('low'),
    recap: threadRecapSchema.optional()
  })
  .strict();

export const coverageSchema = z
  .object({
    projectsFound: z.number().int().nonnegative(),
    threadsFound: z.number().int().nonnegative(),
    deepRead: z.number().int().nonnegative(),
    fileChecked: z.number().int().nonnegative(),
    truncated: z.boolean(),
    inaccessible: z.array(boundedText(500)).max(100)
  })
  .strict();

const snapshotBaseShape = {
  generatedAt: boundedText(80),
  source: z.enum(['review-project-progress', 'codex-app-server', 'demo']),
  coverage: coverageSchema,
  projects: z.array(snapshotProjectSchema)
};

const snapshotThreadV3Schema = snapshotThreadSchema.extend({ displayTitle: boundedText(120).min(1) });

export const projectBriefSchema = z
  .object({
    projectKey: boundedText(300),
    overview: boundedText(2_000).min(1),
    currentStage: boundedText(800).min(1),
    workState: workStateSchema,
    stopPoint: boundedText(2_000).min(1),
    codexOrExternalNext: boundedText(2_000).min(1),
    evidenceLevel: evidenceLevelSchema,
    evidenceReason: boundedText(2_000).min(1),
    confidence: confidenceSchema,
    lastMeaningfulAt: boundedText(80).optional(),
    observedAt: boundedText(80)
  })
  .strict();

export const snapshotTodoSchema = z
  .object({
    todoKey: boundedText(700),
    projectKey: boundedText(300),
    sourceThreadKeys: z.array(boundedText(700)).max(30),
    kind: todoActionKindSchema,
    strength: todoStrengthSchema,
    title: boundedText(500).min(1),
    minimumAction: boundedText(2_000).min(1),
    whyNow: boundedText(2_000).min(1),
    unlocks: boundedText(2_000).min(1),
    evidence: boundedText(2_000).min(1),
    explicitDeadline: boundedText(80).optional(),
    actionEvidence: z.object({ origin: z.enum(['user_request','accepted_plan','explicit_handoff']), sourceRefs: z.array(boundedText(700)).min(1).max(12) }).strict().optional(),
    confidence: confidenceSchema,
    sidebarIndex: z.number().int().nonnegative().optional(),
    observedAt: boundedText(80)
  })
  .strict();

export const boardSnapshotV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    ...snapshotBaseShape,
    threads: z.array(snapshotThreadSchema).max(5_000)
  })
  .strict();

export const boardSnapshotV2Schema = z
  .object({
    schemaVersion: z.literal(2),
    ...snapshotBaseShape,
    threads: z.array(snapshotThreadSchema).max(5_000),
    projectBriefs: z.array(projectBriefSchema),
    todos: z.array(snapshotTodoSchema).max(5_000)
  })
  .strict()
  .superRefine(validatePortfolioSnapshot);

export const boardSnapshotV3Schema = z
  .object({
    schemaVersion: z.literal(3),
    summaryLanguage: z.literal('zh-CN'),
    ...snapshotBaseShape,
    threads: z.array(snapshotThreadV3Schema).max(5_000),
    projectBriefs: z.array(projectBriefSchema),
    todos: z.array(snapshotTodoSchema).max(5_000)
  })
  .strict()
  .superRefine(validatePortfolioSnapshot);

export const boardSnapshotV4Schema = z.object({
  schemaVersion: z.literal(4), summaryLanguage: z.literal('zh-CN'), ...snapshotBaseShape,
  threads: z.array(snapshotThreadV3Schema).max(5_000),
  projectBriefs: z.array(projectBriefSchema), todos: z.array(snapshotTodoSchema).max(5_000)
}).strict().superRefine(validatePortfolioSnapshot);

interface PortfolioSnapshotForValidation {
  projects: Array<{ projectKey: string }>;
  threads: Array<{ threadKey: string; projectKey?: string }>;
  projectBriefs: Array<{ projectKey: string; evidenceLevel: EvidenceLevel }>;
  todos: Array<{ todoKey: string; projectKey: string; sourceThreadKeys: string[] }>;
}

function validatePortfolioSnapshot(snapshot: PortfolioSnapshotForValidation, context: z.RefinementCtx): void {
    const projectKeys = new Set<string>();
    const threadProjects = new Map<string, string | undefined>();
    const projectBriefs = new Map(snapshot.projectBriefs.map((brief) => [brief.projectKey, brief]));
    const briefKeys = new Set<string>();
    const todoKeys = new Set<string>();

    for (const project of snapshot.projects) {
      if (projectKeys.has(project.projectKey)) {
        context.addIssue({ code: 'custom', path: ['projects'], message: `Duplicate project: ${project.projectKey}` });
      }
      projectKeys.add(project.projectKey);
    }
    for (const thread of snapshot.threads) {
      if (threadProjects.has(thread.threadKey)) {
        context.addIssue({ code: 'custom', path: ['threads'], message: `Duplicate thread: ${thread.threadKey}` });
      }
      threadProjects.set(thread.threadKey, thread.projectKey);
      if (thread.projectKey && !projectKeys.has(thread.projectKey)) {
        context.addIssue({ code: 'custom', path: ['threads'], message: `Unknown project in thread: ${thread.threadKey}` });
      }
    }

    for (const brief of snapshot.projectBriefs) {
      if (briefKeys.has(brief.projectKey)) {
        context.addIssue({ code: 'custom', path: ['projectBriefs'], message: `Duplicate project brief: ${brief.projectKey}` });
      }
      briefKeys.add(brief.projectKey);
      if (!projectKeys.has(brief.projectKey)) {
        context.addIssue({ code: 'custom', path: ['projectBriefs'], message: `Unknown project in brief: ${brief.projectKey}` });
      }
    }
    for (const projectKey of projectKeys) {
      if (!briefKeys.has(projectKey)) {
        context.addIssue({ code: 'custom', path: ['projectBriefs'], message: `Missing project brief: ${projectKey}` });
      }
    }
    for (const todo of snapshot.todos) {
      if (todoKeys.has(todo.todoKey)) {
        context.addIssue({ code: 'custom', path: ['todos'], message: `Duplicate todo: ${todo.todoKey}` });
      }
      todoKeys.add(todo.todoKey);
      if (!projectKeys.has(todo.projectKey)) {
        context.addIssue({ code: 'custom', path: ['todos'], message: `Unknown project in todo: ${todo.projectKey}` });
      }
      if (todo.sourceThreadKeys.length === 0 && projectBriefs.get(todo.projectKey)?.evidenceLevel !== 'file_verified') {
        context.addIssue({
          code: 'custom',
          path: ['todos'],
          message: `Todo ${todo.todoKey} without a source thread requires a file-verified project brief.`
        });
      }
      const todoSources = new Set<string>();
      for (const threadKey of todo.sourceThreadKeys) {
        if (todoSources.has(threadKey)) {
          context.addIssue({ code: 'custom', path: ['todos'], message: `Duplicate source thread in todo ${todo.todoKey}: ${threadKey}` });
        }
        todoSources.add(threadKey);
        if (!threadProjects.has(threadKey)) {
          context.addIssue({ code: 'custom', path: ['todos'], message: `Unknown source thread in todo ${todo.todoKey}: ${threadKey}` });
        } else if (threadProjects.get(threadKey) !== todo.projectKey) {
          context.addIssue({ code: 'custom', path: ['todos'], message: `Todo ${todo.todoKey} crosses project boundaries.` });
        }
      }
    }
}

export const boardSnapshotSchema = z.discriminatedUnion('schemaVersion', [boardSnapshotV1Schema, boardSnapshotV2Schema, boardSnapshotV3Schema, boardSnapshotV4Schema]);

export type BoardSnapshotV1 = z.infer<typeof boardSnapshotV1Schema>;
export type BoardSnapshotV2 = z.infer<typeof boardSnapshotV2Schema>;
export type BoardSnapshotV3 = z.infer<typeof boardSnapshotV3Schema>;
export type BoardSnapshotV4 = z.infer<typeof boardSnapshotV4Schema>;
export type BoardSnapshot = z.infer<typeof boardSnapshotSchema>;
export type SnapshotProject = z.infer<typeof snapshotProjectSchema>;
export type SnapshotThread = z.infer<typeof snapshotThreadSchema>;
export type ProjectBrief = z.infer<typeof projectBriefSchema>;
export type SnapshotTodo = z.infer<typeof snapshotTodoSchema>;
export type RuntimeState = z.infer<typeof runtimeStateSchema>;
export type WorkState = z.infer<typeof workStateSchema>;
export type HumanAction = z.infer<typeof humanActionSchema>;
export type ActionStrength = z.infer<typeof actionStrengthSchema>;
export type Confidence = z.infer<typeof confidenceSchema>;
export type EvidenceLevel = z.infer<typeof evidenceLevelSchema>;
export type TodoActionKind = z.infer<typeof todoActionKindSchema>;
export type TodoStrength = z.infer<typeof todoStrengthSchema>;
export type ManualPriority = z.infer<typeof manualPrioritySchema>;

export const canvasNodeSchema = z
  .object({
    pageId: boundedText(100).min(1).optional(),
    id: boundedText(700),
    kind: z.enum(['task', 'note']),
    threadKey: boundedText(700).nullable(),
    projectKey: boundedText(300).nullable().optional(),
    archivedAt: boundedText(80).nullable().optional(),
    manualPriority: manualPrioritySchema.nullable().optional(),
    effectivePriority: z.enum(['p1', 'p2']).nullable().optional(),
    prioritySource: z.enum(['manual', 'date', 'both']).nullable().optional(),
    noteSchedule: noteScheduleSchema.nullable().optional(),
    contentEditedAt: z.iso.datetime().nullable().optional(),
    skinRef: skinRefSchema.nullable().optional(),
    aspectLocked: z.boolean().nullable().optional(),
    foldedIntoNodeId: boundedText(700).nullable().optional(),
    x: z.number().finite(),
    y: z.number().finite(),
    width: z.number().min(12).max(4160),
    height: z.number().min(9).max(4160),
    contentScale: z.number().finite().min(.125).max(8).optional(),
    zIndex: z.number().int(),
    title: boundedText(500),
    body: z.string().max(20_000),
    noteSource: conversationNoteSourceSchema.nullable().optional(),
    noteDocument: noteDocumentSchema.nullable().optional(),
    notePresentation: z.enum(['note', 'image']).optional(),
    lastViewedAt: boundedText(80).nullable(),
    revision: z.number().int().nonnegative(),
    createdAt: boundedText(80),
    updatedAt: boundedText(80)
  })
  .strict();

export const annotationSchema = z
  .object({
    id: boundedText(100),
    targetNodeId: boundedText(700),
    body: boundedText(8_000),
    resolved: z.boolean(),
    revision: z.number().int().nonnegative(),
    createdAt: boundedText(80),
    updatedAt: boundedText(80)
  })
  .strict();

export const linkBendSchema = z.object({ along: z.number().finite().min(-4).max(4), normal: z.number().finite().min(-4).max(4) }).strict();

export const localLinkSchema = z
  .object({
    id: boundedText(100),
    sourceNodeId: boundedText(700),
    targetNodeId: boundedText(700),
    label: boundedText(160),
    bend: linkBendSchema.nullable().optional(),
    revision: z.number().int().nonnegative(),
    createdAt: boundedText(80)
  })
  .strict();

export type CanvasNodeRecord = z.infer<typeof canvasNodeSchema>;
export type AnnotationRecord = z.infer<typeof annotationSchema>;
export type LocalLinkRecord = z.infer<typeof localLinkSchema>;

export const inkPointSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  pressure: z.number().min(0).max(1)
}).strict();

export const inkStrokeSchema = z.object({
  pageId: boundedText(100).min(1).optional(),
  id: boundedText(100),
  tool: inkToolSchema,
  points: z.array(inkPointSchema).min(1).max(20_000),
  color: boundedText(64).min(1),
  size: z.number().finite().min(0.25).max(256),
  opacity: z.number().finite().min(0).max(1),
  layer: inkLayerSchema,
  zIndex: z.number().int(),
  revision: z.number().int().nonnegative(),
  createdAt: boundedText(80),
  updatedAt: boundedText(80)
}).strict();

export type InkPoint = z.infer<typeof inkPointSchema>;
export type InkStrokeRecord = z.infer<typeof inkStrokeSchema>;

export interface HistoryStatus {
  focusPageId?: string;
  canUndo: boolean;
  canRedo: boolean;
  undoLabel: string | null;
  redoLabel: string | null;
}

export const drawingPreferencesSchema = z.object({
  penColor: boundedText(64).min(1),
  penSize: z.number().finite().min(0.25).max(256),
  highlighterColor: boundedText(64).min(1),
  highlighterColorSlots: z.array(z.string().regex(/^#[0-9a-fA-F]{6}$/)).length(6).default(['#f1c75b', '#f39dba', '#a4d785', '#86c9ed', '#b9a1e3', '#f2aa73']),
  highlighterSize: z.number().finite().min(0.25).max(256),
  eraserMode: z.enum(['whole', 'precision']),
  lassoMode: z.enum(['ink', 'all']),
  layer: inkLayerSchema,
  paletteCollapsed: z.boolean()
}).strict();

export type DrawingPreferences = Omit<z.infer<typeof drawingPreferencesSchema>, 'highlighterColorSlots'> & { highlighterColorSlots?: string[] };

export const curatorReplySchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('answer'),
      answer: boundedText(12_000),
      relatedThreadKeys: z.array(boundedText(700)).max(20).default([])
    })
    .strict(),
  z
    .object({
      kind: z.literal('handoff'),
      reason: boundedText(2_000),
      targetThreadKey: boundedText(700).nullable(),
      draft: boundedText(8_000)
    })
    .strict()
]);

export type CuratorReply = z.infer<typeof curatorReplySchema>;

export interface BoardThread extends SnapshotThread {
  displayTitle: string;
  lastObservedAt: string;
  missingSince: string | null;
  /** Present when the board can compare the saved recap to collected source evidence. */
  recapOutdated?: boolean;
}

export interface BoardProjectBrief extends ProjectBrief {
  lastObservedAt: string;
  missingSince: string | null;
}

export interface BoardTodo extends SnapshotTodo {
  lastObservedAt: string;
  missingSince: string | null;
}

export interface BoardState {
  priorityDate?: string;
  pages?: CanvasPageRecord[];
  boardRevision: number;
  projects: SnapshotProject[];
  threads: BoardThread[];
  projectBriefs: BoardProjectBrief[];
  todos: BoardTodo[];
  nodes: CanvasNodeRecord[];
  annotations: AnnotationRecord[];
  links: LocalLinkRecord[];
  inkStrokes: InkStrokeRecord[];
  viewport: { x: number; y: number; zoom: number };
  settings: {
    activePageId?: string;
    defaultPageId?: string;
    theme: 'archive-paper' | 'ink-constellation';
    activeSkinRef: string | null;
    priorityIcons?: PriorityIcons;
    wallpaper?: Wallpaper | null;
    wallpaperPresets?: WallpaperPresetSummary[];
    skinComponents: SkinComponents;
    keyBindings: Record<string, string>;
    drawingPreferences: DrawingPreferences;
    curatorThreadId: string | null;
    lastDailyReviewDate: string | null;
    lastGlobalSnapshotAt: string | null;
  };
  historyStatus: HistoryStatus;
}

export const updateNodeInputSchema = z
  .object({
    x: z.number().finite().optional(),
    y: z.number().finite().optional(),
    width: z.number().min(12).max(4160).optional(),
    height: z.number().min(9).max(4160).optional(),
    zIndex: z.number().int().optional(),
    title: boundedText(500).optional(),
    body: z.string().max(20_000).optional(),
    noteDocument: noteDocumentSchema.nullable().optional(),
    notePresentation: z.enum(['note', 'image']).optional(),
    editSessionId: z.string().min(1).max(128).optional(),
    lastViewedAt: boundedText(80).nullable().optional(),
    skinRef: skinRefSchema.nullable().optional(),
    aspectLocked: z.boolean().nullable().optional(),
    foldedIntoNodeId: boundedText(700).nullable().optional(),
    revision: z.number().int().nonnegative()
  })
  .strict();

export const updateNodesInputSchema = z.object({
  updates: z.array(z.object({
    id: boundedText(700),
    patch: updateNodeInputSchema
  }).strict()).min(1).max(200)
}).strict().superRefine((value, context) => {
  const ids = new Set<string>();
  value.updates.forEach((item, index) => {
    if (ids.has(item.id)) context.addIssue({ code: 'custom', path: ['updates', index, 'id'], message: 'Duplicate node id.' });
    ids.add(item.id);
  });
});

const selectionRefs = (idLength: number, limit: number) => z.array(z.object({
  id: boundedText(idLength), revision: z.number().int().nonnegative()
}).strict()).max(limit);
const selectionFields = { nodes: selectionRefs(700, 200), ink: selectionRefs(100, 2000) };
export const selectionActionSchema = z.discriminatedUnion('action', [
  z.object({ ...selectionFields, action: z.literal('movePage'), targetPageId: boundedText(100).min(1), delta: z.object({ x: z.number().finite().min(-10_000_000).max(10_000_000), y: z.number().finite().min(-10_000_000).max(10_000_000) }).strict().optional() }).strict(),
  z.object({ ...selectionFields, action: z.literal('scale'), origin: z.object({
    x: z.number().finite().min(-10_000_000).max(10_000_000), y: z.number().finite().min(-10_000_000).max(10_000_000)
  }).strict(), factor: z.number().finite().min(.001).max(1000) }).strict(),
  z.object({ ...selectionFields, action: z.literal('translate'), delta: z.object({
    x: z.number().finite().min(-10_000_000).max(10_000_000),
    y: z.number().finite().min(-10_000_000).max(10_000_000)
  }).strict() }).strict(),
  z.object({ ...selectionFields, action: z.literal('delete') }).strict()
]).superRefine((value, context) => {
  if (!value.nodes.length && !value.ink.length) context.addIssue({ code: 'custom', message: 'Empty selection.' });
  for (const key of ['nodes', 'ink'] as const) {
    if (new Set(value[key].map((item) => item.id)).size !== value[key].length) context.addIssue({ code: 'custom', path: [key], message: 'Duplicate selection id.' });
  }
});
export type SelectionAction = z.infer<typeof selectionActionSchema>;
export interface SelectionResult {
  archivedNoteIds: string[]; deletedInkIds: string[]; keptNodeIds: string[]; boardRevision: number;
}

export const setNodePrioritiesInputSchema = z
  .object({
    updates: z.array(z.object({
      id: boundedText(700),
      revision: z.number().int().nonnegative(),
      manualPriority: manualPrioritySchema.nullable(),
      noteSchedule: noteScheduleSchema.nullable().optional()
    }).strict()).min(1).max(200)
  })
  .strict()
  .superRefine((value, context) => {
    const ids = new Set<string>();
    for (const [index, update] of value.updates.entries()) {
      if (ids.has(update.id)) context.addIssue({ code: 'custom', path: ['updates', index, 'id'], message: 'Duplicate node id.' });
      ids.add(update.id);
    }
  });

export type NodePriorityUpdate = z.infer<typeof setNodePrioritiesInputSchema>['updates'][number];

export const createNoteInputSchema = z
  .object({
    pageId: boundedText(100).min(1).optional(),
    clientRequestId: z.string().trim().min(8).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/, 'Invalid client request id.').optional(),
    title: boundedText(500).default(''),
    body: z.string().max(20_000),
    noteDocument: noteDocumentSchema.nullable().optional(),
    notePresentation: z.enum(['note', 'image']).optional(),
    x: z.number().finite(),
    y: z.number().finite(),
    width: z.number().min(96).max(520).default(210),
    height: z.number().min(72).max(520).default(150)
  })
  .strict();

export const archiveNoteInputSchema = z
  .object({ archived: z.boolean(), revision: z.number().int().nonnegative() })
  .strict();

export const deleteNoteInputSchema = z
  .object({ revision: z.number().int().nonnegative() })
  .strict();

export const createAnnotationInputSchema = z
  .object({ targetNodeId: boundedText(700), body: boundedText(8_000) })
  .strict();

export const createLinkInputSchema = z
  .object({ sourceNodeId: boundedText(700), targetNodeId: boundedText(700), label: boundedText(160).default('') })
  .strict()
  .refine((value) => value.sourceNodeId !== value.targetNodeId, 'A node cannot link to itself.');

export const updateLinkInputSchema = z.object({ bend: linkBendSchema.nullable(), revision: z.number().int().nonnegative() }).strict();
export const deleteLinkInputSchema = z.object({ revision: z.number().int().nonnegative() }).strict();

export const viewportSchema = pageViewportSchema;

const inkStrokeFields = {
  tool: inkToolSchema,
  points: z.array(inkPointSchema).min(1).max(20_000),
  color: boundedText(64).min(1),
  size: z.number().finite().min(0.25).max(256),
  opacity: z.number().finite().min(0).max(1),
  layer: inkLayerSchema,
  zIndex: z.number().int()
};

export const createInkStrokeInputSchema = z.object({
  pageId: boundedText(100).min(1).optional(),
  id: boundedText(100).optional(),
  ...inkStrokeFields
}).strict();

export const updateInkStrokeInputSchema = z.object({
  tool: inkToolSchema.optional(),
  points: inkStrokeFields.points.optional(),
  color: inkStrokeFields.color.optional(),
  size: inkStrokeFields.size.optional(),
  opacity: inkStrokeFields.opacity.optional(),
  layer: inkStrokeFields.layer.optional(),
  zIndex: inkStrokeFields.zIndex.optional(),
  revision: z.number().int().nonnegative()
}).strict();

export const deleteInkStrokeInputSchema = z.object({
  revision: z.number().int().nonnegative()
}).strict();

export const inkStrokeBatchInputSchema = z.object({
  creates: z.array(createInkStrokeInputSchema).max(200).default([]),
  updates: z.array(z.object({
    id: boundedText(100),
    patch: updateInkStrokeInputSchema
  }).strict()).max(200).default([]),
  deletes: z.array(z.object({
    id: boundedText(100),
    revision: z.number().int().nonnegative()
  }).strict()).max(200).default([])
}).strict().superRefine((value, context) => {
  if (value.creates.length + value.updates.length + value.deletes.length === 0) {
    context.addIssue({ code: 'custom', message: 'At least one ink change is required.' });
  }
  const ids = [...value.creates.map((item) => item.id).filter((id): id is string => Boolean(id)),
    ...value.updates.map((item) => item.id), ...value.deletes.map((item) => item.id)];
  if (new Set(ids).size !== ids.length) context.addIssue({ code: 'custom', message: 'Duplicate ink stroke id.' });
});

export const setActiveSkinInputSchema = z.object({
  skinRef: skinRefSchema.nullable()
}).strict();

export const setSkinSettingsInputSchema = z.object({
  activeSkinRef: skinRefSchema.nullable().optional(),
  components: skinComponentsSchema.optional()
}).strict().refine((value) => value.activeSkinRef !== undefined || value.components !== undefined,
  'At least one Skin setting is required.');

export const keyBindingsSchema = z.record(z.string().trim().min(1).max(80), z.string().trim().min(1).max(80))
  .superRefine((bindings, context) => {
    const used = new Map<string, string>();
    const reserved = new Set(['escape', 'esc', 'space', 'ctrl+enter', 'control+enter', 'backspace', 'delete']);
    for (const [action, shortcut] of Object.entries(bindings)) {
      const normalized = shortcut.trim().toLocaleLowerCase().replaceAll(' ', '');
      if (reserved.has(normalized)) {
        context.addIssue({ code: 'custom', path: [action], message: 'This shortcut has a fixed safety or destructive meaning.' });
      }
      const conflict = used.get(normalized);
      if (conflict) context.addIssue({ code: 'custom', path: [action], message: `Shortcut conflicts with ${conflict}.` });
      else used.set(normalized, action);
    }
  });

export const interactionSettingsInputSchema = z.object({
  keyBindings: keyBindingsSchema.optional(),
  drawingPreferences: drawingPreferencesSchema.optional()
}).strict().refine((value) => value.keyBindings !== undefined || value.drawingPreferences !== undefined,
  'At least one interaction setting is required.');

export const MAX_SNAPSHOT_BYTES = 2_000_000;
export const SNAPSHOT_MARKER = 'zz-board-snapshot';
