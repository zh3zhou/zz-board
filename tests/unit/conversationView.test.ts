import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ConversationLane } from '../../src/web/ConversationHistory.js';
import { floatingBounds, mergeConversationTurns, conversationGroups } from '../../src/web/conversationView.js';
import type { ConversationTurn, ConversationColumn } from '../../src/shared/conversationHistory.js';

const turn = (id: string, ordinal: number, previous: string | null = null): ConversationTurn => ({
  turnId: id, ordinal, previousTurnId: previous, continuesPrevious: Boolean(previous), title: `问题 ${id}`,
  summary: '讨论了导出问题，尚无交付记录。', occurredAt: null, sourceRefs: [`${id}:user`],
  reference: null, revision: 1, unread: true, sequence: ordinal, sourceFingerprint: id
});
describe('conversation reading view', () => {
  it('keeps a visible canvas border at desktop and narrow sizes and clamps dragging', () => {
    for (const [width, height] of [[1920,1080],[1366,768],[360,640]]) {
      const bounds = floatingBounds(width,height);
      expect(bounds.x).toBeGreaterThan(0); expect(bounds.y).toBeGreaterThan(0);
      expect(bounds.x+bounds.width).toBeLessThan(width); expect(bounds.y+bounds.height).toBeLessThan(height);
      const moved = floatingBounds(width,height,{...bounds,x:-300,y:9999});
      expect(moved.x).toBeGreaterThan(0); expect(moved.y+moved.height).toBeLessThan(height);
    }
  });
  it('preserves dragged coordinates on refresh and only constrains them on resize', () => {
    const moved={x:210,y:110,width:950,height:600};
    expect(floatingBounds(1920,1080,moved)).toEqual(moved);
    const small=floatingBounds(800,600,moved);
    expect(small.x+small.width).toBeLessThan(800); expect(small.y+small.height).toBeLessThan(600);
  });
  it('retains older loaded pages and rejects an older revision while updating content', () => {
    const old=[turn('a',0),{...turn('b',1),revision:3}];
    const merged=mergeConversationTurns(old,[{...turn('b',1),summary:'迟到旧内容'},turn('c',2)]);
    expect(merged.map(t=>t.turnId)).toEqual(['a','b','c']); expect(merged[1].revision).toBe(3);
  });
  it('folds adjacent continuations only, preserving a later return to an earlier topic', () => {
    const input=[turn('a',0),turn('b',1,'a'),turn('c',2),{...turn('d',3,'a'),reference:{turnId:'a',label:'导出'}}];
    expect(conversationGroups(input).map(g=>g.map(t=>t.turnId))).toEqual([['a','b'],['c'],['d']]);
  });
  it('shows raw safe text, real date absence, coverage and folded per-turn records', () => {
    const column:ConversationColumn={threadKey:'local:test',title:'<script>不执行</script>',sourceUpdatedAt:null,turns:[turn('a',0),turn('b',1,'a')],hasEarlier:true,nextCursor:'earlier',coverage:['只覆盖最近二十回合'],checkedAt:null};
    const html=renderToStaticMarkup(createElement(ConversationLane,{column,projectKey:'p',online:true,busy:false,onEarlier(){}}));
    expect(html).toContain('&lt;script&gt;');expect(html).not.toContain('<script>');
    expect(html).toContain('时间未知');expect(html).toContain('2 回合');expect(html).toContain('更早的 20 回合');expect(html).toContain('只覆盖最近二十回合');
  });
  it('maximizes only at native window creation, never on tray or second-instance restore', () => {
    const source=readFileSync(new URL('../../src-tauri/src/lib.rs',import.meta.url),'utf8');
    expect(source).toContain('.maximized(true)');
    expect(source.slice(source.indexOf('fn show_main_window'),source.indexOf('fn tray_icon'))).not.toMatch(/\.maximiz/);
    expect(source).toContain('.visible(!background)');
  });
  it('keeps the earlier-page entry when source history is exhausted but cached pages remain', () => {
    const column:ConversationColumn={threadKey:'local:test',title:'记录',sourceUpdatedAt:null,turns:[turn('a',20)],hasEarlier:false,hasStoredEarlier:true,nextCursor:null,coverage:[],checkedAt:null};
    const html=renderToStaticMarkup(createElement(ConversationLane,{column,projectKey:'p',online:true,busy:false,onEarlier(){}}));
    expect(html).toContain('查看已保存的更早回合');
    expect(html).not.toContain('从 Codex 读取');
  });
  it('unmounts the reading portal before entering export and isolates image paste', () => {
    const app=readFileSync(new URL('../../src/web/App.tsx',import.meta.url),'utf8');
    const reader=readFileSync(new URL('../../src/web/ConversationHistory.tsx',import.meta.url),'utf8');
    expect(app).toMatch(/suppressConversation=\{[^}]*\bexportOpen\b/);
    expect(app).toContain("tab === 'timeline' && !suppressConversation && <ConversationHistory");
    expect(reader).toContain('onPaste={e => { e.preventDefault(); e.stopPropagation(); }}');
  });
  it('distinguishes partially summarized content from a recent source timestamp', () => {
    const column:ConversationColumn={threadKey:'t',title:'记录',sourceUpdatedAt:'2026-09-28T12:00:00Z',turns:[turn('a',0)],hasEarlier:false,nextCursor:null,coverage:[],checkedAt:null,knownTurns:20,pendingTurns:10};
    const html=renderToStaticMarkup(createElement(ConversationLane,{column,projectKey:'p',online:true,busy:false,onEarlier(){}}));
    expect(html).toContain('已整理 10 / 20 回合'); expect(html).toContain('10 回合待整理');
    expect(html).toContain('来源更新时间不代表所有内容已经整理完成');
  });
});
