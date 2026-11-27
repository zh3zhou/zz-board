import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/server/app.js';
import { BoardDatabase } from '../../src/server/database.js';
import { loadConfig } from '../../src/server/config.js';
import { bundle, source, summary } from '../fixtures/summary.js';
import { grantSyntheticCodexAccess } from '../fixtures/codexAccess.js';
let app: FastifyInstance | undefined;
afterEach(async()=>{await app?.close();app=undefined;});
const headers={'x-zz-board-mutation':'1'};
describe('summary sync local API',()=>{
  it('uses an explicitly saved catalog model for new evidence but never generates while preparing, saving, or rechecking cached evidence', async()=>{
    const db=new BoardDatabase(':memory:');grantSyntheticCodexAccess(db);
    const calls:Array<[string,string]> = [];
    const config=loadConfig({ZZ_BOARD_DATA_DIR:path.join(tmpdir(),`zz-board-model-${randomUUID()}`)});
    app=await buildApp({...config,databasePath:':memory:'},{db,summaryRuntime:{
      models:async()=>[{id:'gpt-6.2-sol',efforts:['medium']},{id:'gpt-6.1-terra',efforts:['medium']}],
      summarize:async input=>{calls.push([input.model,input.effort]);return {value:summary(calls.length===1?'a':'b'),usage:null,model:input.model};}
    }});
    const submit = async(id:string) => {
      const job=(await app!.inject({method:'POST',url:'/api/sync/jobs',headers,payload:{bundle:bundle([source(id)])}})).json();
      for(let i=0;i<100;i++){const saved=db.getSyncJobs().find(j=>j.id===job.id);if(saved?.state==='complete')return saved;await new Promise(r=>setTimeout(r,5));}
      throw Error('Synthetic job did not complete');
    };
    const prepared=await app.inject({method:'POST',url:'/api/codex/prepare',headers,payload:{}});
    expect(prepared.json()).toMatchObject({available:true});expect(calls).toHaveLength(0);
    await submit('a');
    const choice={model:'gpt-6.1-terra',effort:'medium'};
    expect((await app.inject({method:'PATCH',url:'/api/summary/settings',headers,payload:{...choice,effort:'high'}})).statusCode).toBe(400);
    expect((await app.inject({method:'PATCH',url:'/api/summary/settings',headers,payload:choice})).json()).toEqual(choice);
    expect((await app.inject({url:'/api/summary/settings'})).json()).toEqual(choice);
    expect(await submit('a')).toMatchObject({skipped:1,total:0});expect(calls).toEqual([['gpt-6.2-sol','medium']]);
    await submit('b');expect(calls).toEqual([['gpt-6.2-sol','medium'],['gpt-6.1-terra','medium']]);
  });
  it('requires deliberate writes and validates model/effort without fallback',async()=>{
    let calls=0;
    const db = new BoardDatabase(':memory:'); grantSyntheticCodexAccess(db);
    app=await buildApp({...loadConfig({}),databasePath:':memory:'},{db,summaryRuntime:{models:async()=>[{id:'gpt-5.6-sol',efforts:['low','medium']}],summarize:async()=>{calls++;return {value:summary(),usage:null,model:'gpt-5.6-sol'};}}});
    expect((await app.inject({method:'GET',url:'/api/summary/models'})).json().models[0].id).toBe('gpt-5.6-sol');
    expect((await app.inject({method:'POST',url:'/api/sync/jobs',payload:{bundle:bundle()}})).statusCode).toBe(403);
    expect((await app.inject({method:'PATCH',url:'/api/summary/settings',headers,payload:{model:'gpt-5.6-sol',effort:'high'}})).statusCode).toBe(400);
    expect((await app.inject({method:'GET',url:'/api/summary/settings'})).json()).toEqual({model:'gpt-6.2-sol',effort:'medium'});
    const result=await app.inject({method:'POST',url:'/api/sync/jobs',headers,payload:{bundle:bundle()}});
    expect(result.statusCode).toBe(200);expect(result.json().id).toBeTruthy();
    await new Promise(r=>setTimeout(r,10));
    expect((await app.inject({method:'GET',url:'/api/sync/jobs'})).json().jobs[0].state).toBe('complete');expect(calls).toBe(1);
    const ordinary=(await app.inject({method:'GET',url:'/api/sync/instructions'})).json().prompt;
    const force=(await app.inject({method:'GET',url:'/api/sync/instructions?force=true'})).json().prompt;
    expect(ordinary).toContain('若用户明确指定本次范围，只采集这些项目。');
    expect(ordinary).not.toContain('--force');expect(force).toContain('--force');expect(force).toContain('SKILL.md');
  });
});
