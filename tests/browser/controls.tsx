import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BUILT_IN_SKINS, skinVersionKey } from '../../src/shared/skin.js';
import { applySkinVariables, composedSkinStyle } from '../../src/web/skinRuntime.js';
import { ConversationHistory } from '../../src/web/ConversationHistory.js';
import { ColorPalette, DEFAULT_COLOR_SLOTS } from '../../src/web/ColorPalette.js';
import { AutoCheckPanel } from '../../src/web/AutoCheckPanel.js';
import { SkinSample } from '../../src/web/SkinPanel.js';
import '../../src/web/focusedNote.css';
import '../../src/web/styles.css';
import '../../src/web/summarySync.css';
import '../../src/web/export.css';
import '../../src/web/noteTools.css';
import './controls.css';

// Only synthetic local UI. No server, board data or summary calls are used.
const manifests=BUILT_IN_SKINS.map(s=>s.manifest);
const cases=manifests.map(m=>({label:m.displayName,key:skinVersionKey(m),chrome:undefined as string|undefined}));
cases.push({label:'浅画布 × 夜墨界面',key:'archive-paper@2.0.0',chrome:'ink-constellation@2.0.0/chrome'}, {label:'深画布 × 静纸界面',key:'ink-constellation@2.0.0',chrome:'archive-paper@2.0.0/chrome'});
const apply=(index:number)=>{const c=cases[index]!;applySkinVariables(document.documentElement.style,composedSkinStyle(manifests,c.key,{chrome:c.chrome}));};
apply(4);
const rgba=(value:string)=>{const canvas=document.createElement('canvas');canvas.width=canvas.height=1;const ctx=canvas.getContext('2d')!;ctx.fillStyle=value;ctx.fillRect(0,0,1,1);return [...ctx.getImageData(0,0,1,1).data].map((v,i)=>i===3?v/255:v);};
const over=(fg:number[],bg:number[])=>[0,1,2].map(i=>fg[i]!*fg[3]!+bg[i]!*(1-fg[3]!)).concat(1);
function surface(element:Element|null):number[]{if(!element)return [255,255,255,1];return over(rgba(getComputedStyle(element).backgroundColor),surface(element.parentElement));}
function ratio(fg:number[],bg:number[]){const lum=(rgb:number[])=>rgb.slice(0,3).map(v=>v/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4).reduce((s,v,i)=>s+v*[.2126,.7152,.0722][i]!,0);return (Math.max(lum(fg),lum(bg))+.05)/(Math.min(lum(fg),lum(bg))+.05);}
function checkControls(){const failures:string[]=[];let checked=0;for(const element of document.querySelectorAll<HTMLElement>('#samples button, #samples select, #samples input:not([type=checkbox]):not([type=color]), #samples textarea')){
  if(!element.getClientRects().length||getComputedStyle(element).visibility==='hidden'||!((element.textContent||'').trim()||element instanceof HTMLInputElement||element instanceof HTMLTextAreaElement))continue;
  const style=getComputedStyle(element), bg=surface(element);let opacity=1;for(let e:Element|null=element;e;e=e.parentElement)opacity*=Number(getComputedStyle(e).opacity);
  const color=rgba(style.color);color[3]=color[3]!*opacity;
  const value=ratio(over(color,bg),bg);checked++;
  if(value<4.5)failures.push(`${element.textContent?.trim().slice(0,24)||element.getAttribute('aria-label')}: ${value.toFixed(2)}:1`);
}return {checked,failures};}
function Harness(){const [theme,setTheme]=useState(4),[report,setReport]=useState('尚未运行'),[color,setColor]=useState('#f1c75b');
function run(){const results=cases.map((c,index)=>{apply(index);return {skin:c.label,...checkControls()};});apply(theme);setReport(JSON.stringify({pass:results.every(r=>!r.failures.length),results},null,2));}
return <main className="control-lab"><header className="lab-header"><div><h1>Skin 控件验收</h1><p>只使用合成内容，不连接正式看板。覆盖默认、选中、禁用与原生表单。</p></div><select aria-label="验收 Skin" value={theme} onChange={e=>{const i=Number(e.target.value);setTheme(i);apply(i);}}>{cases.map((c,i)=><option key={i} value={i}>{c.label}</option>)}</select><button onClick={run}>检查全部 Skin</button></header>
<div id="samples" className="lab-grid">
<section className="lab-panel"><h2>看板与放大便签</h2><SkinSample manifests={manifests} skinKey={cases[theme]!.key} /></section>
<section className="lab-panel"><h2>项目详情</h2><p>画布与界面可以来自不同 Skin，文字仍需清楚。</p><ConversationHistory projectKey="synthetic" projectName="示例项目" online={false} revision={0}/><div className="panel-tabs"><button aria-current="true">概览</button><button>对话</button><button>批注</button></div><div className="project-refresh"><button>检查更新</button><button disabled>正在检查</button></div></section>
<section className="lab-panel"><h2>通用操作 / 设置</h2><div className="lab-actions"><button>默认操作</button><button disabled>暂不可用</button><button className="primary">保存批注</button></div><div className="summary-sync-panel"><label>模型<select aria-label="模型"><option>当前所选模型</option></select></label><button>复制同步指令</button><button disabled>排队中</button></div><label>搜索<input aria-label="搜索" defaultValue="中文项目内容"/></label><textarea aria-label="便签编辑" defaultValue={'中文  空格\n换行内容'}/><AutoCheckPanel online={false}/></section>
<section className="lab-panel"><h2>导出 / 工具</h2><div className="export-toolbar lab-export"><header><strong>导出区域</strong></header><p className="export-help">拖角调整范围 · 右键 / Esc 返回</p><div className="export-scale-options"><button>1×</button><button aria-pressed="true">2×</button><button>4×</button></div><output>1478 × 1341 px</output><button className="export-primary">生成预览</button><button disabled>等待选区</button></div><ColorPalette label="荧光笔" value={color} slots={DEFAULT_COLOR_SLOTS} opacity={.3} onChange={setColor} placement="below"/><div className="selection-actions lab-selection"><button>移动选区</button><button>归档便签</button></div></section>
</div><details open className="lab-report"><summary>计算样式与文字对比度报告</summary><pre role="status">{report}</pre></details></main>;}
createRoot(document.getElementById('root')!).render(<Harness/>);
