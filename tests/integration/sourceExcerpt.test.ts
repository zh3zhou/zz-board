import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../../src/server/app.js';
import { CodexAppServerClient } from '../../src/server/codex/appServerClient.js';
import { loadConfig } from '../../src/server/config.js';
import { BoardDatabase } from '../../src/server/database.js';
import { sourceFingerprint } from '../../src/server/summaryJobs.js';
import { bundle, source, summary, time } from '../fixtures/summary.js';

let app: FastifyInstance | undefined, dir: string;
afterEach(async () => { await app?.close(); app = undefined; if (dir) await rm(dir, { recursive: true, force: true }); vi.restoreAllMocks(); });
const cwd = '/synthetic/example';
const headers = { 'x-zz-board-mutation': '1' };
const access = (localRead: boolean) => ({ schemaVersion: 1 as const, localRead, modelUse: false, decidedAt: time });
type Turn = { id: string; status?: string; items: Record<string, unknown>[] };
const answer = (text: string): Turn => ({ id: 'a', status: 'completed', items: [{ id:'result', type:'agentMessage', phase:'final_answer', text }] });

async function setup(pages: (cursor: unknown) => { data: Turn[]; nextCursor?: string } | Promise<{ data: Turn[]; nextCursor?: string }>,
  options: { role?: 'user' | 'assistant' | 'file'; host?: string; savedCwd?: string | null; projectId?: string; metadata?: Record<string, unknown>; allowed?: boolean } = {}) {
  dir = await mkdtemp(path.join(os.tmpdir(), 'zz-excerpt-'));
  const db = new BoardDatabase(':memory:');
  const input = source(); input.hostId = options.host ?? 'local';
  const packet = bundle([input]);
  packet.projects[0]!.cwd = options.savedCwd === null ? undefined : options.savedCwd ?? cwd;
  packet.projects[0]!.projectId = options.projectId;
  const fingerprint = sourceFingerprint(input); db.prepareEvidence(packet, new Map([[input.threadKey, fingerprint]]));
  db.commitRecap(input, { summary: summary(), sourceFingerprint: fingerprint, sources: [{ id: 'a:result', role: options.role ?? 'assistant', turnId: 'a', occurredAt: time, path: null }],
    evidenceCheckedAt:time, summarizedAt:time, model:'synthetic', effort:'low', promptVersion:'test' });
  if (options.allowed !== false) db.saveCodexAccess(access(true));
  const client = new CodexAppServerClient('unused');
  vi.spyOn(client, 'connect').mockResolvedValue();
  const rpc = vi.spyOn(client, 'request').mockImplementation(async (method, params) => {
    if (method === 'thread/read') { expect(params).toEqual({ threadId:'a', includeTurns:false }); return {thread:options.metadata ?? {id:'a',cwd}}; }
    expect(method).toBe('thread/turns/list');
    const query = params as Record<string, unknown>;
    expect(query).toMatchObject({threadId:'a',limit:20,sortDirection:'desc',itemsView:'full'});
    return pages(query.cursor);
  });
  const summarize = vi.fn(async () => { throw new Error('Unexpected model call'); });
  app = await buildApp({ ...loadConfig({ZZ_BOARD_DATA_DIR:dir}), databasePath:':memory:' }, {db,codex:client,summaryRuntime:{models:vi.fn(),summarize}});
  const server = app;
  const post = (project = 'example', fields = {threadKey:input.threadKey,sourceId:'a:result'}) =>
    server.inject({ method:'POST', url:`/api/projects/${project}/source-excerpt`, headers, payload:fields });
  return {db,rpc,post,server,summarize};
}

describe('on-demand source excerpts', () => {
  it('uses source metadata and at most two bounded pages, clips characters without splitting a surrogate and leaves the board untouched', async () => {
    const raw = '🙂'.repeat(362) + 'private-fixture-tail';
    const {db,rpc,post,server,summarize} = await setup(cursor => cursor ? {data:[answer(raw)]} : {data:[{id:'other',items:[]}],nextCursor:'older'});
    const revision = db.getBoardRevision();
    const reply = await post();
    expect(reply.statusCode).toBe(200); expect(reply.headers['cache-control']).toBe('no-store');
    expect(reply.json()).toEqual({status:'found',text:'🙂'.repeat(360),partial:true});
    expect(rpc.mock.calls.map(call=>call[0])).toEqual(['thread/read','thread/turns/list','thread/turns/list']);
    expect(summarize).not.toHaveBeenCalled();
    expect(db.getBoardRevision()).toBe(revision);
    for (const route of ['/api/board','/api/sync/jobs','/api/reviews/weekly?week=current','/api/projects/example/conversations','/api/projects/example/timeline']) {
      const result = await server.inject(route); expect(result.body).not.toContain('🙂'); expect(result.body).not.toContain('private-fixture-tail');
    }
  });
  it('returns no content for an older reference outside the two pages', async () => {
    const {post,rpc} = await setup(cursor=>({data:[{id:'other',items:[]}],nextCursor:cursor ? 'third':'second'}));
    expect((await post()).json()).toEqual({status:'unavailable',reason:'window'}); expect(rpc).toHaveBeenCalledTimes(3);
  });
  it('checks permission and exact saved scope before reading, then verifies provider identity', async () => {
    const {db,post,rpc} = await setup(()=>({data:[answer('private fixture')]}),{allowed:false,metadata:{id:'different',cwd}});
    expect((await post()).statusCode).toBe(403);
    db.saveCodexAccess(access(true));
    expect((await post('another')).json()).toMatchObject({status:'unavailable'});
    expect((await post('example',{threadKey:'different',sourceId:'a:result'})).json()).toMatchObject({status:'unavailable'});
    expect((await post('example',{threadKey:'codex:local:a',sourceId:'secret'})).json()).toMatchObject({status:'unavailable'});
    expect(rpc).not.toHaveBeenCalled();
    expect((await post()).json()).toMatchObject({status:'unavailable'}); expect(rpc).toHaveBeenCalledTimes(1);
  });
  it.each([{role:'file' as const},{host:'remote-host'}])('does not read a non-local dialogue or file source', async options => {
    const {rpc,post} = await setup(()=>({data:[]}),options);
    expect((await post()).json()).toMatchObject({status:'unavailable'}); expect(rpc).not.toHaveBeenCalled();
  });
  it('verifies the metadata directory before requesting any turns', async () => {
    const {post,rpc} = await setup(()=>({data:[answer('private fixture')]}),{metadata:{id:'a',cwd:'/synthetic/another'}});
    expect((await post()).json()).toMatchObject({status:'unavailable'}); expect(rpc).toHaveBeenCalledTimes(1);
  });
  it.each([
    { label:'no stored identifiers', savedCwd:null, projectId:undefined, metadata:{id:'a',cwd}, found:false, rpcCount:0 },
    { label:'relative cwd alone', savedCwd:'relative', projectId:undefined, metadata:{id:'a',cwd:'relative'}, found:false, rpcCount:0 },
    { label:'matched ID alone', savedCwd:null, projectId:'native', metadata:{id:'a',projectId:'native'}, found:true, rpcCount:2 },
    { label:'registered ID absent from metadata', savedCwd:null, projectId:'native', metadata:{id:'a',cwd}, found:false, rpcCount:1 },
    { label:'both native identifiers absent', savedCwd:cwd, projectId:'native', metadata:{id:'a'}, found:false, rpcCount:1 },
    { label:'native ID matches, native directory absent', savedCwd:cwd, projectId:'native', metadata:{id:'a',projectId:'native'}, found:true, rpcCount:2 },
    { label:'directory matches, native ID absent', savedCwd:cwd, projectId:'native', metadata:{id:'a',cwd}, found:true, rpcCount:2 },
    { label:'directory matches, ID conflicts', savedCwd:cwd, projectId:'native', metadata:{id:'a',cwd,projectId:'different'}, found:false, rpcCount:1 },
    { label:'ID matches, directory conflicts', savedCwd:cwd, projectId:'native', metadata:{id:'a',cwd:'/another',projectId:'native'}, found:false, rpcCount:1 }
  ])('requires independently matching project metadata: $label', async ({savedCwd,projectId,metadata,found,rpcCount}) => {
    const {post,rpc} = await setup(()=>({data:[answer('原文')]}),{savedCwd,projectId,metadata});
    expect((await post()).json()).toEqual(found ? {status:'found',text:'原文',partial:false} : {status:'unavailable',reason:'scope'});
    expect(rpc).toHaveBeenCalledTimes(rpcCount);
  });
  it.each([
    {id:'result',type:'userMessage',text:'different role'}, {id:'different',type:'agentMessage',phase:'final_answer',text:'wrong source'},
    {id:'result',type:'agentMessage',phase:'commentary',text:'wrong phase'}, {id:'result',type:'agentMessage',phase:'final_answer',text:'API_KEY=fixture-secret'},
  ])('rejects role, item, phase mismatches and sensitive contents', async item => {
    const {post} = await setup(()=>({data:[{id:'a',items:[item]}]}));
    expect((await post()).json()).toEqual({status:'unavailable',reason:'content'});
  });
  it('returns a contiguous request field; pasted paths and image contents are never dereferenced or concatenated', async () => {
    const {post} = await setup(()=>({data:[{id:'a',items:[{id:'result',type:'userMessage',content:[
      {type:'localImage',path:'/synthetic/hidden'},{type:'text',text:'# AGENTS.md instructions\n<environment_context>private</environment_context>\n## My request:\n完整的中文原句。'},
      {type:'text',text:'另一段不拼接。'}]}]}]}),{role:'user'});
    expect((await post()).json()).toEqual({status:'found',text:'完整的中文原句。',partial:true});
  });
  it('keeps original mixed line endings when selecting an unmodified span from a desktop request', async () => {
    const expected = '第一段\r\n第二段\n第三段';
    const {post} = await setup(()=>({data:[{id:'a',items:[{id:'result',type:'userMessage',text:'# AGENTS.md instructions\r\n## My request:\r\n'+expected}]}]}),{role:'user'});
    expect((await post()).json()).toEqual({status:'found',text:expected,partial:true});
  });
  it.each(['revoke','archive'])('discards a read already in flight on %s, even after restoration', async mode => {
    const pending = Promise.withResolvers<{data:Turn[]}>(), entered = Promise.withResolvers<void>();
    const {db,post} = await setup(()=>{entered.resolve(); return pending.promise;});
    const work = post().then(response=>response); await entered.promise;
    if (mode === 'revoke') { db.saveCodexAccess(access(false)); db.saveCodexAccess(access(true)); }
    else {
      const page = db.getPages()[0]!, replacement = db.createPage('合成替代页');
      const archived = db.archivePage(page.id,{archived:true,revision:page.revision,replacementDefaultPageId:replacement.id});
      db.archivePage(page.id,{archived:false,revision:archived.revision});
    }
    pending.resolve({data:[answer('must stay private')]});
    const reply = await work;
    expect(reply.body).not.toContain('must stay private');
    if (mode === 'revoke') expect(reply.statusCode).toBe(403);
    else expect(reply.json()).toEqual({status:'unavailable',reason:'scope'});
  });
  it('sends the initial board frame then the current permission, and notifies other viewers when consent is revoked', async () => {
    const {server,db} = await setup(()=>({data:[]}));
    await server.listen({host:'127.0.0.1',port:0});
    const address=server.server.address() as AddressInfo;
    const stream=await fetch(`http://127.0.0.1:${address.port}/events`);
    const reader=stream.body!.getReader(), decoder=new TextDecoder();
    let pending='';
    async function next() {
      while (!pending.includes('\n\n')) {
        const chunk=await reader.read(); if (chunk.done) throw new Error('closed event stream');
        pending+=decoder.decode(chunk.value,{stream:true});
      }
      const boundary=pending.indexOf('\n\n'), frame=pending.slice(0,boundary); pending=pending.slice(boundary+2); return frame;
    }
    try {
      expect(await next()).toContain('boardRevision');
      expect(await next()).toBe('event: codex-access\ndata: '+JSON.stringify(db.getCodexAccess()));
      db.saveCodexAccess(access(false));
      expect(await next()).toBe('event: codex-access\ndata: '+JSON.stringify(db.getCodexAccess()));
    } finally { await reader.cancel(); }
  });
});
