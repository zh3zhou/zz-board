import { useEffect, useState } from 'react';
import type { ImageExportResult } from '../shared/imageExport.js';
import { copyNoteText } from './noteClipboard.js';

export function ExportReceipt({ result }: { result: ImageExportResult }) {
  const [pathStatus, setPathStatus] = useState('');
  return <div className="image-export-receipt" role="status">
    <p>{result.saved ? result.copied ? '已保存并复制图片。' : '已保存图片；剪贴板复制未成功。' : result.copied ? '已复制图片；文件未保存。' : '图片未保存，也未复制。'}</p>
    {result.saved && <><small>已保存到</small><button className="export-path" title="点击复制完整文件路径" aria-label="复制已保存图片路径"
      onClick={() => void copyNoteText(result.saved!.path).then(() => setPathStatus('路径已复制。')).catch(() => setPathStatus('路径复制失败，请手动选取下面的路径。'))}>{result.saved.path}</button></>}
    {result.saveError && <small>保存失败：{result.saveError}</small>}{result.copyError && <small>复制失败：{result.copyError}</small>}{pathStatus && <small>{pathStatus}</small>}
  </div>;
}

export function ImageExportFeedback({ onShow, hasNotice }: { onShow(): void; hasNotice: boolean }) {
  const [result, setResult] = useState<ImageExportResult | null>(null);
  useEffect(() => {
    const listener = (event: Event) => { setResult((event as CustomEvent<ImageExportResult>).detail); onShow(); };
    window.addEventListener('zz-image-exported', listener); return () => window.removeEventListener('zz-image-exported', listener);
  }, [onShow]);
  useEffect(() => { if (hasNotice) setResult(null); }, [hasNotice]);
  return result && <div className="notice image-export-notice" onPointerDown={event => event.stopPropagation()}>
    <button className="export-receipt-close" aria-label="关闭图片保存提示" onClick={() => setResult(null)}>×</button><ExportReceipt key={result.saved?.path} result={result} />
  </div>;
}
