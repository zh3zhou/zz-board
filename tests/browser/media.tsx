import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { TaskBubble, type BubbleData } from '../../src/web/TaskBubble.js';
import { NoteEditor } from '../../src/web/NoteEditor.js';
import { noteImage, copyNoteImage } from '../../src/web/noteClipboard.js';
import { exportRegionPng } from '../../src/web/exportScene.js';
import { uploadImage } from '../../src/web/mediaClient.js';
import { canvasPng, copyPng } from '../../src/web/rasterExport.js';
import { BUILT_IN_SKINS } from '../../src/shared/skin.js';
import { globalSkinStyle, applySkinVariables } from '../../src/web/skinRuntime.js';
import type { CanvasNodeRecord, InkStrokeRecord } from '../../src/shared/schema.js';
import type { Node } from '@xyflow/react';
import type { NoteDocument } from '../../src/shared/noteDocument.js';
import '../../src/web/styles.css';

const report: Record<string, unknown> = {};
let fixtureBlob: Blob;
function assert(test: unknown, message: string) { if (!test) throw new Error(message); }
async function save(name: string, blob: Blob) { await fetch(`/acceptance-result/${name}`, { method: 'POST', headers: { 'x-zz-board-mutation': '1' }, body: blob }); }
async function pixels(blob: Blob, points: { x: number; y: number }[] = []) {
  const bitmap = await createImageBitmap(blob), canvas = document.createElement('canvas');
  canvas.width = bitmap.width; canvas.height = bitmap.height;
  try {
    const ctx = canvas.getContext('2d')!; ctx.drawImage(bitmap, 0, 0);
    const values = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    const colors = new Set<string>(); let opaque = true, tealPixels = 0, goldPixels = 0, lastTealY = -1;
    for (let i = 0; i < values.length; i += 4) {
      if (values[i + 3] !== 255) opaque = false;
      const color = `${values[i]},${values[i + 1]},${values[i + 2]}`;
      if (i % 64 === 0) colors.add(color);
      if (color === '33,121,130') { tealPixels++; lastTealY = Math.floor(i / 4 / canvas.width); }
      if (color === '237,178,76') goldPixels++;
    }
    const samples = points.map(point => {
      const index = (Math.floor(point.y) * canvas.width + Math.floor(point.x)) * 4;
      return Array.from(values.subarray(index, index + 4));
    });
    return { width: canvas.width, height: canvas.height, colors: colors.size, opaque, tealPixels, goldPixels, lastTealY, samples };
  } finally { bitmap.close(); canvas.width = canvas.height = 1; }
}
const now = '2026-01-01T00:00:00Z';
function record(id: string, x: number, y: number, extra: Partial<CanvasNodeRecord> = {}): CanvasNodeRecord { return { id, kind: 'note', threadKey: null, title: '', body: '', width: 300, height: 180, x, y, zIndex: 1, revision: 0, lastViewedAt: null, createdAt: now, updatedAt: now, ...extra }; }
function node(record: CanvasNodeRecord): Node<BubbleData> { return { id: record.id, position: { x: record.x, y: record.y }, data: { record, annotationCount: 0, selected: false, canResize: false, exportMode: true, onResizeEnd() {} } }; }
function Harness() {
  const [status, setStatus] = useState('准备就绪'), [sample, setSample] = useState<Node<BubbleData> | null>(null), [preview, setPreview] = useState('');
  const [body, setBody] = useState('中文  空格\n\n空行\n'), [doc, setDoc] = useState<NoteDocument | null>(null);
  async function run() {
    setStatus('正在验收…');
    try {
      const canvas = document.createElement('canvas'); canvas.width = 96; canvas.height = 64; const ctx = canvas.getContext('2d')!; ctx.fillStyle = '#edb24c'; ctx.fillRect(10, 8, 80, 50); ctx.fillStyle = '#217982'; ctx.fillRect(30, 20, 40, 32); fixtureBlob = await canvasPng(canvas); canvas.width = canvas.height = 1;
      const asset = await uploadImage(fixtureBlob);
      const rich: NoteDocument = { version: 1, content: [{ type: 'text', text: '中文  空格\n\n环绕图片 ' }, { type: 'image', assetId: asset.id, side: 'right', width: 45 }, { type: 'text', text: '文字继续。\n不应全黑。' }] };
      const note = node(record('note:a', 0, 0, { body: '中文  空格\n\n环绕图片 文字继续。\n不应全黑。', noteDocument: rich }));
      const scene = { nodes: [note, node(record('note:image', 330, 100, { notePresentation: 'image', noteDocument: { version: 1, content: [{ type: 'image', assetId: asset.id, side: 'right', width: 100 }] } })), node(record('task:a', -130, 230, { kind: 'task', title: '合成项目', width: 150, height: 150 }))], edges: [{ id: 'link', source: 'task:a', target: 'note:image' }], strokes: [{ id: 'ink', tool: 'highlighter', color: '#e0ac32', size: 25, opacity: .3, layer: 'foreground', zIndex: 1, revision: 0, createdAt: now, updatedAt: now, points: [{ x: -300, y: 100, pressure: .5 }, { x: 800, y: 300, pressure: .5 }] } as InkStrokeRecord] };
      for (const name of ['night', 'paper']) {
        const skin = BUILT_IN_SKINS.find(s => s.manifest.schemaVersion === 2 && s.manifest.skinId === (name === 'night' ? 'ink-constellation' : 'archive-paper'))!.manifest;
        applySkinVariables(document.documentElement.style, globalSkinStyle(skin));
        flushSync(() => setSample(note));
        const checks = [];
        for (const scale of [1, 2, 4]) {
          const blob = await exportRegionPng(scene, { x: -40, y: -40, width: 680, height: 430 }, scale, new AbortController().signal, () => {});
          // The two sample points are inside the original's teal rectangle. At
          // 4× they straddle pixel x=2048, so a missing second tile cannot pass.
          const check = await pixels(blob, [{ x: 510 * scale, y: 230 * scale }, { x: 520 * scale, y: 230 * scale }]);
          assert(check.width === 680 * scale && check.height === 430 * scale && check.opaque && check.colors > 20, `${name} ${scale}× 像素尺寸/背景验收失败 ${JSON.stringify(check)}`);
          assert(check.tealPixels > 200 && check.goldPixels > 200 && check.samples.every(color => color.join(',') === '33,121,130,255'), `${name} ${scale}× 对象或跨瓦片内容丢失，不能仅凭背景渐变判为成功：${JSON.stringify(check)}`);
          checks.push({ scale, ...check });
          if (scale === 2) {
            await save(`${name}.png`, blob);
            setPreview(previous => { if (previous) URL.revokeObjectURL(previous); return URL.createObjectURL(blob); });
          }
        }
        report[name] = checks;
      }
      const surface = document.querySelector<HTMLElement>('#sample .bubble-surface')!;
      const tail = '\n末段仍在图片前面。'.repeat(42);
      const expanded = { ...note.data.record, body: note.data.record.body + tail, noteDocument: { version: 1 as const, content: [...rich.content, { type: 'text' as const, text: tail }, { type: 'image' as const, assetId: asset.id, side: 'left' as const, width: 35 }] } };
      const copied = await noteImage(surface, expanded); const notePixels = await pixels(copied);
      report.note = { ...notePixels, canvasSurfaceOpacity: getComputedStyle(surface).opacity };
      await save('note.png', copied);
      assert(notePixels.opaque && notePixels.colors > 20 && notePixels.width === 1400 && notePixels.height > 2 * surface.offsetHeight &&
        notePixels.tealPixels > 200 && notePixels.goldPixels > 200 && notePixels.lastTealY > notePixels.height - 350,
        `完整便签末尾图片验收失败 ${JSON.stringify(report.note)}`);
      // Original is wider than the 1024px preview. At 4×, two-pixel stripes
      // must survive in the output, including the second 2048px tile.
      const fineCanvas = document.createElement('canvas'); fineCanvas.width = 2400; fineCanvas.height = 400;
      const fineContext = fineCanvas.getContext('2d')!;
      for (let x = 0; x < 2400; x += 2) { fineContext.fillStyle = x % 4 === 0 ? '#000000' : '#ffffff'; fineContext.fillRect(x, 0, 2, 400); }
      const fineAsset = await uploadImage(await canvasPng(fineCanvas)); fineCanvas.width = fineCanvas.height = 1;
      const fineNode = node(record('image:fine', 0, 0, { width: 600, height: 100, notePresentation: 'image', noteDocument: { version: 1, content: [{ type: 'image', assetId: fineAsset.id, side: 'right', width: 100 }] } }));
      const fineBlob = await exportRegionPng({ nodes: [fineNode], edges: [], strokes: [] }, { x: 0, y: 0, width: 600, height: 100 }, 4, new AbortController().signal, () => {});
      const finePixels = await pixels(fineBlob, [400, 402, 2100, 2102].map(x => ({ x, y: 200 })));
      assert(finePixels.width === 2400 && finePixels.height === 400 && finePixels.samples.every((color, i) => i % 2 === 0 ? color.slice(0, 3).every(c => c < 30) : color.slice(0, 3).every(c => c > 225)), `原图细线丢失或被低清放大 ${JSON.stringify(finePixels)}`);
      report.sharpness = finePixels; await save('detail.png', fineBlob);
      const many = Array.from({ length: 100 }, (_, i) => node(record(`image:${i}`, (i % 10) * 150, Math.floor(i / 10) * 100, { width: 140, height: 90, notePresentation: 'image', noteDocument: { version: 1, content: [{ type: 'image', assetId: asset.id, width: 100, side: 'right' }] } })));
      const ink = Array.from({ length: 1000 }, (_, i) => ({ ...scene.strokes[0], id: `ink:${i}`, points: [{ x: i % 1500, y: i % 1000, pressure: .5 }, { x: i % 1500 + 10, y: i % 1000 + 8, pressure: .5 }] }));
      const start = performance.now();
      for (let i = 0; i < 2; i++) { const blob = await exportRegionPng({ nodes: many, edges: [], strokes: ink }, { x: 0, y: 0, width: 1500, height: 1000 }, 2, new AbortController().signal, () => {}); if (!i) await save('stress.png', blob); }
      report.stress = { images: 100, uniqueAssets: 1, strokes: 1000, exports: 2, milliseconds: Math.round(performance.now() - start), remainingScenes: document.querySelectorAll('.zz-export-scene').length };
      const abort = new AbortController(); abort.abort(); let cancelled = false;
      try { await exportRegionPng(scene, { x: 0, y: 0, width: 10, height: 10 }, 2, abort.signal, () => {}); } catch { cancelled = true; }
      assert(cancelled && !document.querySelector('.zz-export-scene'), '取消清理失败');
      const midAbort = new AbortController(); let completedTiles = 0, midCancelled = false;
      try { await exportRegionPng(scene, { x: -40, y: -40, width: 680, height: 430 }, 4, midAbort.signal, done => { completedTiles = done; midAbort.abort(); }); } catch { midCancelled = midAbort.signal.aborted; }
      assert(midCancelled && completedTiles === 1 && !document.querySelector('.zz-export-scene'), '分块中途取消未停止或未释放场景');
      const retry = await exportRegionPng(scene, { x: -40, y: -40, width: 680, height: 430 }, 1, new AbortController().signal, () => {});
      assert((await pixels(retry)).tealPixels > 200, '取消后再次导出不可用');
      report.cancel = { beforeStart: cancelled, afterFirstTile: midCancelled, completedTiles, retry: true };
      await save('result.json', new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' })); setStatus(`PASS ${JSON.stringify(report)}`);
    } catch (error) { setStatus(`FAIL ${error instanceof Error ? error.stack : error}`); await save('result.json', new Blob([JSON.stringify({ error: String(error), report })])); }
  }
  return <main style={{ padding: 24, overflow: 'auto', height: '100vh' }}><h1>图文 / PNG 合成验收</h1><p>仅使用合成数据，不读个人看板。</p><button onClick={() => void run()}>运行渲染与资源检查</button><pre style={{ whiteSpace: 'pre-wrap' }}>{status}</pre>
    <div id="sample" style={{ width: 300, height: 180, margin: 20 }}>{sample && <TaskBubble id={sample.id} data={sample.data} />}</div>
    <button disabled={!sample} onClick={() => { if (sample) void copyNoteImage(document.querySelector('#sample .bubble-surface')!, sample.data.record).then(() => setStatus('已生成便签 PNG，请查看保存与复制结果')).catch(e => setStatus(String(e))); }}>复制便签图片</button>
    <button onClick={() => void copyPng(fixtureBlob).then(() => setStatus('合成图片已在剪贴板，可粘贴到下方编辑器'))}>复制合成原图</button>
    <div style={{ width: 450, minHeight: 120, background: 'var(--note-skin-fill)', padding: 20 }}><NoteEditor body={body} document={doc} online onChange={(body, doc) => { setBody(body); setDoc(doc); }} onComposition={() => {}} onFinish={() => {}} onNotice={setStatus} /></div><pre>{JSON.stringify({ body, doc })}</pre>
    {preview && <img src={preview} alt="导出预览" style={{ maxWidth: 700 }} />}
  </main>;
}
createRoot(document.getElementById('fixture-root')!).render(<Harness />);
