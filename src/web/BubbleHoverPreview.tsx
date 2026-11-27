import { useMemo, type CSSProperties } from 'react';
import type { BubbleData } from './TaskBubble.js';
import { taskDisplayTitle } from './bubblePresentation.js';
import { orderedProjectThreads, recapNeedsUpdate, threadSourceTime } from '../shared/projectProgress.js';
import { awaitsResponse, projectActions, threadAction } from './projectActions.js';
import { projectReading, readingDate, readingQualifier, shortRecordDate } from './projectContextReading.js';
import { duplicateThreadLabels } from './ThreadSourceLink.js';
import { hoverSavedTime } from './NoteMetadata.js';
import { displayedPriority, manualPriorityLabel } from './manualPriority.js';

export function BubbleHoverPreview({ data, x, y }: { data: BubbleData; x: number; y: number }) {
  const content = useMemo(() => hoverPreviewContent(data), [data]);
  if (data.project && !content.summary && !content.action && !content.eyebrow) return null;
  return <aside id="canvas-bubble-preview" className={`bubble-hover-preview ${data.record.kind === 'note' ? 'is-note' : ''}`} role="tooltip" style={{ '--preview-x': `${x}px`, '--preview-y': `${y}px` } as CSSProperties}>
    {content.title && <strong>{content.title}</strong>}
    {content.summary && <p>{content.qualifier && <span className="reading-qualifier">{content.qualifier} · </span>}{content.time ? <time dateTime={content.time}>{content.summary}</time> : content.summary}</p>}
    {content.source && <small className="hover-source">{content.source}</small>}
    {content.action && <p className="hover-action">{content.actionLabel && <span>{content.actionLabel}</span>}{content.action}</p>}
    {content.actionSource && <small className="hover-source">{content.actionSource}</small>}
    {content.eyebrow && <small className="hover-source">{content.eyebrow}</small>}
  </aside>;
}

export function hoverPreviewContent(data: BubbleData): { eyebrow: string; title: string; summary: string; qualifier?: string; action: string; actionLabel?: string; source?: string; actionSource?: string; time?: string } {
  const { record, project, thread } = data;
  const priority = manualPriorityLabel(displayedPriority(record));
  const prefix = priority ? `${priority} · ` : '';
  if (record.kind === 'note') {
    const time = record.contentEditedAt ?? record.createdAt;
    const summary = `${record.contentEditedAt ? '上次编辑' : '创建于'} ${hoverSavedTime(time)}`;
    const schedule = record.noteSchedule;
    const due = schedule && `${schedule.completed ? '已完成的期限' : '预期完成'} ${schedule.dueDate}`;
    return { eyebrow: '', title: '', summary, time, action: [priority, due].filter(Boolean).join(' · ') };
  }
  if (project) {
    const [line] = projectReading(project);
    const progressClauses = line?.text.split(/[，。；！？,;!?·\n]/u).map(clause => clause.trim());
    const action = projectActions(project).find(item => awaitsResponse(item) &&
      !(line?.thread && item.sources.some(thread => thread.threadKey === line.thread!.threadKey) &&
        progressClauses?.includes(item.text.replace(/[。.!！?？]+$/u, '').trim())));
    const labels = duplicateThreadLabels(orderedProjectThreads(project.threads));
    const title = (item: typeof project.threads[number]) => labels.get(item.threadKey) ?? item.title;
    const actionSources = action?.sources.filter(thread => thread.threadKey !== line?.thread?.threadKey);
    const source = line && [readingDate(line), line.thread ? `来自「${title(line.thread)}」` : '来自旧项目简报'].filter(Boolean).join(' · ');
    return {
      eyebrow: priority || '',
      title: taskDisplayTitle(thread, record, project.project),
      source, qualifier: line && readingQualifier(line),
      summary: line?.text || '',
      action: action?.text || '', actionLabel: '明确待办',
      actionSource: actionSources?.length ? `来自「${actionSources.map(title).join('」、「')}」` : undefined
    };
  }
  const action = thread && threadAction(thread);
  return {
    eyebrow: thread ? [priority, shortRecordDate(threadSourceTime(thread))].filter(Boolean).join(' · ') : `${prefix}未归项目的对话`,
    title: taskDisplayTitle(thread, record),
    source: thread?.missingSince ? '这次没读到这条对话，显示上次记录' : thread && recapNeedsUpdate(thread) ? '上次摘要（待更新）' : undefined,
    summary: thread?.recap?.summary.stopPoint || thread?.stopPoint || '还没有记录说明上次做到哪儿。',
    action: action?.text || '', actionLabel: action?.strength === 'recommended' ? '建议行动' : '你要做'
  };
}
