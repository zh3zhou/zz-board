import {execFile} from 'node:child_process';
import {promisify,parseArgs} from 'node:util';
import {mkdtemp,mkdir,writeFile,access,rm} from 'node:fs/promises';
import {createServer} from 'node:http';
import path from 'node:path';
import {DEFAULT_SUMMARY_SETTINGS} from '../src/shared/summarySync.js';
import {RuntimeClient,catalogSettings,productionEnvironment,resolveCodexExecutable,disableListedMcp,assertStartupConfiguration,isolationSettings,restrictCatalog,verifyNoTools,configurationArgs,parseFeatureNames} from '../src/server/codex/summaryRuntime.js';
const {values}=parseArgs({args:process.argv.slice(2).filter(arg=>arg!=='--'),options:{apply:{type:'boolean'},model:{type:'string'}}});
const model=values.model ?? DEFAULT_SUMMARY_SETTINGS.model;
if(!/^[a-z0-9][a-z0-9.-]{0,100}$/.test(model)) throw new Error('请提供目录中准确的模型 ID。');
if (!values.apply) { console.log(`Dry run: --apply checks ${model} with a synthetic local endpoint only; no real login or model call.`); process.exit(0); }
const parent=path.resolve('.tmp/runtime-mcp-gate');await mkdir(parent,{recursive:true});
const dir=await mkdtemp(path.join(parent,'run-'));const home=path.join(dir,'home');await mkdir(home);
const marker=path.join(dir,'executed');const script=path.join(dir,'canary.cjs');
await writeFile(script,`require('node:fs').writeFileSync(${JSON.stringify(marker)},'unexpected');`);
let httpRequests=0;const server=createServer((_req,res)=>{httpRequests++;res.end('{}');});await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
const address=server.address() as {port:number};
await writeFile(path.join(home,'config.toml'),`[mcp_servers.local_canary]\ncommand=${JSON.stringify(process.execPath)}\nargs=${JSON.stringify([script])}\nenabled=true\n[mcp_servers.http_canary]\nurl="http://127.0.0.1:${address.port}/mcp"\nenabled=true\n`);
const exe=await resolveCodexExecutable('codex');const env={...productionEnvironment(),CODEX_HOME:home};const args=configurationArgs;
const exec=promisify(execFile);const options={cwd:dir,env,windowsHide:true,encoding:'utf8' as const,timeout:30000,maxBuffer:16000000};
let stage='inventory';try{
 const baseline=catalogSettings(dir);
 const discovery=new RuntimeClient(exe,dir,baseline,env);let listed:any[];
 try{await discovery.connect();const r:any=await discovery.request('config/read',{cwd:dir,includeLayers:true});listed=Object.keys(r.config.mcp_servers??{}).map(name=>({name}));}finally{await discovery.dispose();}
 console.log({stage:'inventory',httpRequests,executed:await access(marker).then(()=>true,()=>false)});
 stage='initialize';const settings=disableListedMcp(baseline,listed);const c=new RuntimeClient(exe,dir,settings,env);
 try{await c.connect();assertStartupConfiguration(await c.request('config/read',{cwd:dir,includeLayers:true}),settings);}finally{await c.dispose();}
 console.log({stage:'config',httpRequests,executed:await access(marker).then(()=>true,()=>false)});
 stage='catalog';const raw=JSON.parse((await exec(exe,['debug','models','--bundled',...args(settings)],options)).stdout);
 const flags=parseFeatureNames((await exec(exe,['features','list',...args(settings)],options)).stdout);
 console.log({stage:'helpers',httpRequests,executed:await access(marker).then(()=>true,()=>false)});
 const catalog=path.join(dir,'catalog.json');await writeFile(catalog,JSON.stringify(restrictCatalog(raw,model)));
 stage='no-tools';await verifyNoTools(exe,dir,disableListedMcp(isolationSettings(dir,catalog,flags),listed),{model,effort:'medium',prompt:'synthetic',outputSchema:{}});
 const executed=await access(marker).then(()=>true,()=>false);
 if(executed||httpRequests)throw new Error('canary_executed');
 console.log({result:'PASS',model,mcpServers:listed.length,httpRequests,canaryExecuted:executed,emptyTools:true,ephemeral:true});
}catch(e:any){console.log({result:'FAIL',stage,code:e.code??'unexpected',message:e.code?e.message:'Synthetic gate failed'});process.exitCode=1;}
finally{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));if(path.dirname(dir)!==parent)throw Error('boundary');await rm(dir,{recursive:true,force:true,maxRetries:5});}
