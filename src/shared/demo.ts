import type { BoardSnapshotV3, HumanAction, RuntimeState, WorkState } from './schema.js';

const projects = [
  'Dynamics Influence on PSE',
  'AutoCAD Exploration',
  'Research Notes',
  'Portfolio Site',
  'Image Art Lab',
  'Resume Strategy',
  'Data Validation',
  'Agent Workflow'
];

const actions: HumanAction[] = ['decide', 'test', 'read_learn', 'review', 'none', 'reply_continue', 'provide_material', 'wait'];
const workStates: WorkState[] = [
  'waiting_for_user',
  'needs_validation',
  'stage_closed',
  'in_progress',
  'complete',
  'insufficient_evidence'
];
const runtimeStates: RuntimeState[] = ['idle', 'idle', 'idle', 'running', 'idle', 'unknown'];

export function createDemoSnapshot(count = 56, now = new Date()): BoardSnapshotV3 {
  const observedAt = now.toISOString();
  const projectRows = projects.map((name, index) => ({
    projectKey: `demo-project-${index}`,
    projectId: `demo-project-${index}`,
    hostId: 'demo',
    name,
    sidebarIndex: index,
    observedAt
  }));

  const threads: BoardSnapshotV3['threads'] = Array.from({ length: count }, (_, index) => {
    const projectIndex = index % projects.length;
    const action = actions[index % actions.length];
    const updated = new Date(now.getTime() - index * 5.5 * 60 * 60 * 1000).toISOString();
    const title = demoTitle(index, projects[projectIndex]);
    return {
      threadKey: `demo:thread-${index}`,
      sourceKind: 'demo' as const,
      hostId: 'demo',
      threadId: `thread-${index}`,
      projectKey: `demo-project-${projectIndex}`,
      title,
      displayTitle: demoDisplayTitle(index, projects[projectIndex]),
      sidebarIndex: index,
      observedAt,
      sourceUpdatedAt: updated,
      runtimeState: runtimeStates[index % runtimeStates.length],
      workState: workStates[index % workStates.length],
      humanAction: action,
      actionStrength: action === 'none' || action === 'wait' ? ('none' as const) : index % 3 === 0 ? ('blocking' as const) : ('recommended' as const),
      stopPoint:
        index === 0
          ? 'A complex modeling discussion reached a decision fork and still needs the user to choose the claim boundary.'
          : index === 1
            ? 'The prototype is ready, but the critical manual interaction has not been verified.'
            : `The last useful step was recorded for ${title}; the next owner is explicit.`,
      evidence: `Synthetic fixture · updated ${updated}`,
      confidence: index % 5 === 0 ? ('medium' as const) : ('high' as const)
    };
  });

  const projectBriefs = projectRows.map((project) => {
    const projectThreads = threads.filter((thread) => thread.projectKey === project.projectKey);
    const lead = projectThreads[0];
    if (!lead) {
      return {
        projectKey: project.projectKey,
        overview: 'No recent synthetic task is available for this project.',
        currentStage: 'Unknown — no recent task evidence',
        workState: 'insufficient_evidence' as const,
        stopPoint: 'Unknown: this snapshot contains no associated task to establish where work stopped.',
        codexOrExternalNext: 'Deep-read the project before inferring a next step.',
        evidenceLevel: 'none' as const,
        evidenceReason: 'Synthetic coverage contains the saved project but no associated task.',
        confidence: 'low' as const,
        observedAt
      };
    }
    return {
      projectKey: project.projectKey,
      overview: `Synthetic portfolio summary for ${project.name}.`,
      currentStage: `Synthetic ${lead.workState.replaceAll('_', ' ')} stage`,
      workState: lead.workState,
      stopPoint: lead.stopPoint,
      codexOrExternalNext: lead.humanAction === 'none' ? 'No next action is supported by this synthetic evidence.' : `Continue after the ${lead.humanAction} action is resolved.`,
      evidenceLevel: 'deep_read' as const,
      evidenceReason: `Derived from ${projectThreads.length} synthetic task${projectThreads.length === 1 ? '' : 's'}; the lead task is ${lead.threadKey}.`,
      confidence: lead.confidence,
      lastMeaningfulAt: lead.sourceUpdatedAt,
      observedAt
    };
  });

  const todos = projectRows.flatMap((project, projectIndex) => {
    const lead = threads.find((thread) =>
      thread.projectKey === project.projectKey &&
      thread.humanAction !== 'none' &&
      thread.humanAction !== 'uncertain' &&
      thread.actionStrength !== 'none'
    );
    if (!lead || lead.humanAction === 'none' || lead.humanAction === 'uncertain' || lead.actionStrength === 'none') return [];
    return [{
      todoKey: `demo-todo-${projectIndex}`,
      projectKey: project.projectKey,
      sourceThreadKeys: [lead.threadKey],
      kind: lead.humanAction,
      strength: lead.actionStrength,
      title: lead.title,
      minimumAction: demoMinimumAction(lead.humanAction),
      whyNow: lead.stopPoint,
      unlocks: `The next synthetic step for ${project.name}.`,
      evidence: lead.evidence,
      confidence: lead.confidence,
      sidebarIndex: project.sidebarIndex,
      observedAt
    }];
  });

  return {
    schemaVersion: 3,
    summaryLanguage: 'zh-CN',
    generatedAt: observedAt,
    source: 'demo',
    coverage: {
      projectsFound: projectRows.length,
      threadsFound: threads.length,
      deepRead: Math.min(16, threads.length),
      fileChecked: 2,
      truncated: false,
      inaccessible: []
    },
    projects: projectRows,
    threads,
    projectBriefs,
    todos
  };
}

function demoTitle(index: number, project: string): string {
  const verbs = ['Resolve', 'Review', 'Test', 'Map', 'Read', 'Compare', 'Refine', 'Pause'];
  return `${verbs[index % verbs.length]} · ${project} · ${String(index + 1).padStart(2, '0')}`;
}

function demoDisplayTitle(index: number, project: string): string {
  const verbs = ['决策', '审阅', '测试', '梳理', '阅读', '比较', '完善', '暂缓'];
  return `${verbs[index % verbs.length]} · ${project}`;
}

function demoMinimumAction(action: Exclude<HumanAction, 'none' | 'uncertain'>): string {
  return ({
    test: 'Run the smallest manual interaction check and record the result.',
    review: 'Review the latest artifact and leave one concrete response.',
    read_learn: 'Read the named material and record the key takeaway.',
    decide: 'Choose the current decision branch and record the boundary.',
    provide_material: 'Provide the smallest missing file or data sample.',
    approve: 'Approve or reject the pending scoped action.',
    reply_continue: 'Reply with the instruction needed to resume.',
    wait: 'Monitor the external condition; no active work is required yet.'
  })[action];
}
