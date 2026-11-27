import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { BoardThread } from '../shared/schema.js';
import type { ConversationBatch, ConversationColumn, ConversationEvidence, ConversationHistory, ConversationSummary, ConversationTurn } from '../shared/conversationHistory.js';

export const conversationHash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
/** Semantic state only: never adds a canvas undo entry. Raw message text is not stored. */
export class ConversationStore {
  constructor(private readonly db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS conversation_projects(project_key TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS conversation_columns(thread_key TEXT PRIMARY KEY,project_key TEXT NOT NULL,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS conversation_turns(thread_key TEXT NOT NULL,turn_id TEXT NOT NULL,ordinal INTEGER NOT NULL,
        fingerprint TEXT NOT NULL,summary_fingerprint TEXT,data TEXT,revision INTEGER NOT NULL DEFAULT 0,seen_revision INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(thread_key,turn_id));
      CREATE INDEX IF NOT EXISTS conversation_order ON conversation_turns(thread_key,ordinal);`);
  }
  enabled(key: string): boolean { return Boolean(this.db.prepare('SELECT 1 FROM conversation_projects WHERE project_key=?').get(key)); }
  enable(key: string): void { this.db.prepare('INSERT OR IGNORE INTO conversation_projects VALUES (?)').run(key); }
  metadata(key: string): Omit<ConversationColumn, 'turns'> | null {
    const row = this.db.prepare('SELECT data FROM conversation_columns WHERE thread_key=?').get(key);
    return row ? JSON.parse(String(row.data)) : null;
  }
  updateColumn(projectKey: string, value: Omit<ConversationColumn, 'turns'>): void {
    value={...value,orderingRevision:value.orderingRevision ?? this.metadata(value.threadKey)?.orderingRevision ?? 0};
    this.db.prepare('INSERT INTO conversation_columns VALUES (?,?,?) ON CONFLICT(thread_key) DO UPDATE SET project_key=excluded.project_key,data=excluded.data')
      .run(value.threadKey, projectKey, JSON.stringify(value));
  }
  page(threadKey: string, before?: number, limit = 20): ConversationTurn[] {
    return this.db.prepare('SELECT data,revision,seen_revision FROM conversation_turns WHERE thread_key=? AND data IS NOT NULL AND ordinal<? ORDER BY ordinal DESC LIMIT ?')
      .all(threadKey, before ?? Number.MAX_SAFE_INTEGER, Math.min(2000, limit)).reverse()
      .map(row => ({ ...JSON.parse(String(row.data)), unread: Number(row.revision) > Number(row.seen_revision) }));
  }
  columnPage(threadKey: string, before?: number, beforeTurnId?: string, limit=20): ConversationColumn {
    const metadata=this.metadata(threadKey);
    if (!metadata) throw new Error('此对话尚未整理。');
    if (beforeTurnId) {
      const anchor=this.db.prepare('SELECT ordinal FROM conversation_turns WHERE thread_key=? AND turn_id=?').get(threadKey,beforeTurnId);
      if (!anchor) throw new Error('分页位置已失效，请重新读取对话。');
      before=Number(anchor.ordinal);
    }
    const turns=this.page(threadKey,before,limit);
    const hasStoredEarlier=turns.length>0 && Boolean(this.db.prepare('SELECT 1 FROM conversation_turns WHERE thread_key=? AND ordinal<? AND data IS NOT NULL LIMIT 1').get(threadKey,turns[0]!.ordinal));
    const counts=this.db.prepare('SELECT COUNT(*) AS known, SUM(CASE WHEN data IS NULL OR summary_fingerprint IS NULL OR summary_fingerprint<>fingerprint THEN 1 ELSE 0 END) AS pending FROM conversation_turns WHERE thread_key=?').get(threadKey)!;
    return {...metadata,turns,hasStoredEarlier,knownTurns:Number(counts.known),pendingTurns:Number(counts.pending ?? 0)};
  }
  history(projectKey: string, threads: BoardThread[]): ConversationHistory {
    const latest=(t:BoardThread)=>[this.metadata(t.threadKey)?.sourceUpdatedAt ?? '',t.sourceUpdatedAt ?? ''].sort().at(-1)!;
    const recent = threads.filter(t => t.projectKey === projectKey).sort((a,b) => latest(b).localeCompare(latest(a)) || a.threadKey.localeCompare(b.threadKey)).slice(0,3);
    const sidebar = recent.every(t => t.sidebarIndex !== undefined);
    if (sidebar) recent.sort((a,b) => a.sidebarIndex! - b.sidebarIndex!);
    return { projectKey, enabled: this.enabled(projectKey), order: sidebar ? 'sidebar' : 'recent', gaps: ['仅整理已读取的真实回合；不代表完整项目历史。'],
      threads: recent.map(t => this.metadata(t.threadKey) ? {...this.columnPage(t.threadKey),title:t.title,sourceUpdatedAt:latest(t)||null} : { threadKey: t.threadKey, title: t.title, sourceUpdatedAt: t.sourceUpdatedAt ?? null,
        hasEarlier: false, nextCursor: null, coverage: ['尚未整理对话历程。'], checkedAt: null,turns:[] }) };
  }
  prepare(threadKey: string, turns: ConversationEvidence[], older: boolean): ConversationEvidence[] {
    this.db.exec('SAVEPOINT conversation_prepare');
    try {
      const prepared=this.prepareOrdered(threadKey,turns,older);
      this.db.exec('RELEASE conversation_prepare');return prepared;
    } catch(error) {
      this.db.exec('ROLLBACK TO conversation_prepare; RELEASE conversation_prepare');throw error;
    }
  }
  private prepareOrdered(threadKey: string, turns: ConversationEvidence[], older: boolean): ConversationEvidence[] {
    const rows = this.db.prepare('SELECT turn_id,ordinal,data,fingerprint,revision FROM conversation_turns WHERE thread_key=? ORDER BY ordinal,turn_id').all(threadKey);
    const order=rows.map(r=>String(r.turn_id));
    const metadata=this.metadata(threadKey);
    for (let index=0;index<turns.length;index++) {
      const turn=turns[index]!;if (order.includes(turn.turnId)) continue;
      const next=turns.slice(index+1).find(t=>order.includes(t.turnId));
      const previous=turns.slice(0,index).findLast(t=>order.includes(t.turnId));
      const anchor=older && metadata?.cursorBeforeTurnId ? order.indexOf(metadata.cursorBeforeTurnId) : -1;
      const insertion=next ? order.indexOf(next.turnId) : previous ? order.indexOf(previous.turnId)+1 : anchor>=0 ? anchor : older ? 0 : order.length;
      order.splice(insertion,0,turn.turnId);
    }
    const changedInputs=new Set(turns.filter(t=>rows.some(r=>r.turn_id===t.turnId && r.fingerprint!==t.fingerprint)).map(t=>t.turnId));
    for (const row of rows) {
      const ordinal=order.indexOf(String(row.turn_id));
      const data=row.data ? JSON.parse(String(row.data)) as ConversationTurn : null;
      const invalidRelation=data?.continuesPrevious && (changedInputs.has(data.previousTurnId ?? '') || order[ordinal-1]!==data.previousTurnId);
      if (ordinal!==Number(row.ordinal) || invalidRelation) this.db.prepare('UPDATE conversation_turns SET ordinal=?,data=?,revision=?,summary_fingerprint=CASE WHEN ? THEN NULL ELSE summary_fingerprint END WHERE thread_key=? AND turn_id=?')
        .run(ordinal,data ? JSON.stringify({...data,ordinal,...(invalidRelation ? {continuesPrevious:false,revision:Number(row.revision)+1,unread:true} : {})}) : null,Number(row.revision)+(invalidRelation?1:0),invalidRelation?1:0,threadKey,row.turn_id);
    }
    if (metadata && rows.some(row=>order.indexOf(String(row.turn_id))!==Number(row.ordinal))) {
      const project=this.db.prepare('SELECT project_key FROM conversation_columns WHERE thread_key=?').get(threadKey)!;
      this.updateColumn(String(project.project_key),{...metadata,orderingRevision:(metadata.orderingRevision ?? 0)+1});
    }
    return turns.map((turn,index) => {
      const ordinal = order.indexOf(turn.turnId);
      const saved=rows.find(r=>r.turn_id===turn.turnId)?.data;
      const previous = turn.previousTurnId ?? (index===0 && saved ? (JSON.parse(String(saved)) as ConversationTurn).previousTurnId : null);
      this.db.prepare('INSERT INTO conversation_turns(thread_key,turn_id,ordinal,fingerprint) VALUES (?,?,?,?) ON CONFLICT(thread_key,turn_id) DO UPDATE SET fingerprint=excluded.fingerprint')
        .run(threadKey, turn.turnId, ordinal, turn.fingerprint);
      const previousFingerprint=previous ? String(this.db.prepare('SELECT fingerprint FROM conversation_turns WHERE thread_key=? AND turn_id=?').get(threadKey,previous)?.fingerprint ?? '') || null : null;
      return { ...turn, ordinal, previousTurnId: previous,previousFingerprint };
    });
  }
  hasTurn(threadKey:string,turnId:string):boolean {return Boolean(this.db.prepare('SELECT 1 FROM conversation_turns WHERE thread_key=? AND turn_id=?').get(threadKey,turnId));}
  cached(threadKey: string, turn: ConversationEvidence): boolean {
    return this.db.prepare('SELECT summary_fingerprint FROM conversation_turns WHERE thread_key=? AND turn_id=?').get(threadKey, turn.turnId)?.summary_fingerprint === turn.fingerprint;
  }
  current(batch: ConversationBatch): boolean {
    return batch.turns.every(turn => this.db.prepare('SELECT fingerprint FROM conversation_turns WHERE thread_key=? AND turn_id=?').get(batch.threadKey, turn.turnId)?.fingerprint === turn.fingerprint);
  }
  commit(batch: ConversationBatch, summaries: ConversationSummary[]): number {
    if (!this.current(batch)) return 0;
    let changed = 0;
    for (const summary of summaries) {
      const input = batch.turns.find(t => t.turnId === summary.turnId)!;
      const row = this.db.prepare('SELECT data,revision,ordinal FROM conversation_turns WHERE thread_key=? AND turn_id=?').get(batch.threadKey, input.turnId)!;
      const old = row.data ? JSON.parse(String(row.data)) as ConversationTurn : null;
      const before=this.db.prepare('SELECT turn_id,fingerprint FROM conversation_turns WHERE thread_key=? AND ordinal<? ORDER BY ordinal DESC LIMIT 1').get(batch.threadKey,row.ordinal);
      const meaningful = { ...summary,continuesPrevious:summary.continuesPrevious && before?.turn_id===input.previousTurnId && before?.fingerprint===input.previousFingerprint, occurredAt: input.occurredAt, previousTurnId: input.previousTurnId };
      const differs = !old || Object.entries(meaningful).some(([key,value]) => JSON.stringify(old[key as keyof ConversationTurn]) !== JSON.stringify(value));
      const revision = Number(row.revision) + (differs ? 1 : 0);
      const turn: ConversationTurn = { ...meaningful, sourceFingerprint: input.fingerprint, ordinal: Number(row.ordinal), revision, unread: differs,
        sequence: differs ? Date.now() : old!.sequence };
      this.db.prepare('UPDATE conversation_turns SET data=?,summary_fingerprint=?,revision=? WHERE thread_key=? AND turn_id=?').run(JSON.stringify(turn),input.fingerprint,revision,batch.threadKey,input.turnId);
      if (differs) changed++;
    }
    if (batch.olderPage) this.finishOlderPage(batch.projectKey,batch.threadKey,batch.olderPage);
    return changed;
  }
  finishOlderPage(projectKey:string,threadKey:string,page:NonNullable<ConversationBatch['olderPage']>):void {
    const metadata=this.metadata(threadKey);
    if (metadata?.nextCursor!==page.cursor || page.turns.some(turn=>!this.cached(threadKey,turn as ConversationEvidence))) return;
    this.updateColumn(projectKey,{...metadata,nextCursor:page.nextCursor,cursorBeforeTurnId:page.beforeTurnId,hasEarlier:page.nextCursor!==null});
  }
  markRead(projectKey: string, items: Array<{threadKey:string;turnId:string;revision:number}>): void {
    for (const item of items) this.db.prepare(`UPDATE conversation_turns SET seen_revision=MAX(seen_revision,MIN(revision,?)) WHERE thread_key=? AND turn_id=?
      AND EXISTS(SELECT 1 FROM conversation_columns WHERE thread_key=? AND project_key=?)`).run(item.revision,item.threadKey,item.turnId,item.threadKey,projectKey);
  }
}
