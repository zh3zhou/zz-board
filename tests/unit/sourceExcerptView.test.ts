import { isValidElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BoardThread, SnapshotProject } from '../../src/shared/schema.js';
import type { ExcerptSource, SourceExcerptResult } from '../../src/shared/sourceExcerpt.js';
import { SourceExcerpt } from '../../src/web/SourceExcerpt.js';
import { api } from '../../src/web/api.js';
import { source, time } from '../fixtures/summary.js';

// Drive the element's actual click, close and cleanup handlers in the node-only test runtime.
const hooks = vi.hoisted(() => ({ index:0, slots:[] as unknown[], effects:[] as Array<()=>void | (()=>void)> }));
vi.mock('react', async original => ({
  ...await original<typeof import('react')>(),
  useState(initial: unknown) {
    const i=hooks.index++; if (!(i in hooks.slots)) hooks.slots[i]=initial;
    return [hooks.slots[i],(value:unknown)=>{hooks.slots[i]=value;}];
  },
  useRef(current: unknown) { const i=hooks.index++; return hooks.slots[i] ??= {current}; },
  useEffect(effect:()=>void | (()=>void)) { hooks.effects.push(effect); }
}));

const project: SnapshotProject = {projectKey:'example',name:'合成项目',cwd:'/synthetic/example',observedAt:time};
const thread: BoardThread = {...source(),hostId:'local',title:'合成对话',displayTitle:'摘要',stopPoint:'',evidence:'', confidence:'low',
  workState:'insufficient_evidence',humanAction:'uncertain',actionStrength:'none',lastObservedAt:time,observedAt:time,missingSince:null};
const ref: ExcerptSource = {id:'a:result',turnId:'a',role:'assistant',occurredAt:time,path:null};
const props = {project,thread,source:ref,canRead:true};
function renderControl() {
  const outer=SourceExcerpt(props)!;
  if (typeof outer.type !== 'function') throw Error('Missing excerpt control');
  hooks.index=0; hooks.effects.length=0;
  const tree = outer.type(outer.props) as ReactElement<{children:ReactElement[]}>;
  const button = tree.props.children[0]!;
  if (!isValidElement<{onClick():void}>(button)) throw Error('Missing excerpt action');
  return {html:renderToStaticMarkup(tree),click:()=>button.props.onClick()};
}
beforeEach(()=>{hooks.index=0;hooks.slots.length=0;hooks.effects.length=0;});
afterEach(()=>vi.restoreAllMocks());

describe('transient source excerpt control', () => {
  it('mounts no control for disabled, wrong-project, remote or file references and remounts when the source changes', () => {
    for (const changed of [{canRead:false},{project:{...project,cwd:undefined}},{project:{...project,projectKey:'other'}},{thread:{...thread,hostId:'remote'}},{source:{...ref,role:'file' as const}},{source:{...ref,turnId:null}}]) {
      expect(SourceExcerpt({...props,...changed})).toBeNull();
    }
    const current=SourceExcerpt(props)!, next=SourceExcerpt({...props,source:{...ref,id:'other'}})!;
    expect(next.key).not.toBe(current.key);
  });
  it('fetches only on click, discards late replies on close and clears the displayed text on the next close', async () => {
    const pending=Promise.withResolvers<SourceExcerptResult>();
    const read=vi.spyOn(api,'sourceExcerpt').mockReturnValueOnce(pending.promise).mockResolvedValue({status:'found',text:'<真实原文>',partial:true});
    const initial=renderControl(); expect(initial.html).toContain('查看原文'); expect(read).not.toHaveBeenCalled();
    initial.click(); expect(read).toHaveBeenCalledOnce();
    const signal=read.mock.calls[0]![3];
    const loading=renderControl(); expect(loading.html).toContain('正在读取'); loading.click(); expect(signal.aborted).toBe(true);
    pending.resolve({status:'found',text:'过期内容',partial:false}); await pending.promise;
    const closed=renderControl(); expect(closed.html).not.toContain('过期内容'); closed.click(); await Promise.resolve();
    const visible=renderControl(); expect(visible.html).toContain('&lt;真实原文&gt;'); expect(visible.html).toContain('节选');
    visible.click(); expect(renderControl().html).not.toContain('真实原文');
  });
  it('aborts an unfinished request when switching away or losing permission unmounts the control', async () => {
    const pending=Promise.withResolvers<SourceExcerptResult>();
    const read=vi.spyOn(api,'sourceExcerpt').mockReturnValue(pending.promise);
    const live=renderControl(); const disposals=hooks.effects.map(effect=>effect());
    live.click(); disposals.forEach(dispose=>dispose?.());
    expect(read.mock.calls[0]![3].aborted).toBe(true);
    pending.resolve({status:'found',text:'过期内容',partial:false}); await pending.promise;
    expect(renderControl().html).not.toContain('过期内容');
  });
});
