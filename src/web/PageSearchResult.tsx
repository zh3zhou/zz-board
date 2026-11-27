import { threadSourceTime } from '../shared/projectProgress.js';
import type { PageSearchMatch } from './pageCanvas.js';

function compact(text: string, limit: number, tail: number): string {
  const chars = Array.from(text);
  return chars.length <= limit ? text : chars.slice(0, limit - tail - 1).join('') + '…' + chars.slice(-tail).join('');
}

function surroundingMatch(text: string, query: string): string {
  const folded = text.toLocaleLowerCase();
  const index = folded.indexOf(query);
  if (index < 0 || !query) return '';
  let start = index, end = index + query.length;
  // Some characters expand when folded, e.g. İ. Keep displayed offsets in the original text.
  if (folded.length !== text.length) {
    let source = 0, offset = 0;
    for (const char of text) {
      const next = offset + char.toLocaleLowerCase().length;
      if (offset <= index && index < next) start = source;
      source += char.length;
      if (next >= index + query.length) { end = source; break; }
      offset = next;
    }
  }
  const left = Array.from(text.slice(0, start)), right = Array.from(text.slice(end));
  const match = compact(text.slice(start, end), 48, 16);
  return ((left.length > 12 ? '…' : '') + left.slice(-12).join('') + match +
    right.slice(0, 16).join('') + (right.length > 16 ? '…' : '')).replace(/\s+/gu, ' ').trim();
}

export function PageSearchResult({ record, page, thread, identity, query, onLocate }: PageSearchMatch & {
  query: string; onLocate(): void;
}) {
  const originalTitle = thread?.title ?? record.title;
  const title = originalTitle.trim().replace(/\s+/gu, ' ');
  const term = query.trim().toLocaleLowerCase();
  const shortTitle = compact(title, 48, 16);
  const snippet = shortTitle.toLocaleLowerCase().includes(term) ? '' :
    surroundingMatch(originalTitle, term) || (!thread ? surroundingMatch(record.body, term) : '');
  const label = shortTitle || snippet || '空白便签';
  const isThread = Boolean(thread || record.threadKey);
  const time = thread && threadSourceTime(thread);
  const location = [isThread ? '对话' : record.kind === 'task' ? '项目' : '便签',
    isThread && (record.projectKey && !record.threadKey ? record.title : '未归项目'),
    page?.name || 'page 1', identity, time && new Date(time).toLocaleDateString('zh-CN'),
    thread?.missingSince && '上次记录', page?.archivedAt && '归档只读'].filter(Boolean).join(' · ');
  const context = title && snippet;
  return <button type="button" className="page-search-result" onClick={onLocate}
    aria-label={[title || label, context, location].filter(Boolean).join('，')}>
    <span>{label}</span>
    {context && <small>{context}</small>}
    <small>{location}</small>
  </button>;
}
