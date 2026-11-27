import path from 'node:path';
import { homedir } from 'node:os';
import fs from 'node:fs/promises';
import { checkCodexOperation, type CodexOperationGuard } from '../../shared/codexAccess.js';

type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue => value !== null && typeof value === 'object' ? value as RecordValue : {};
const within = (root: string, file: string) => {
  const relative = path.relative(root, file);
  return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
};

/** Read only Codex's explicit pasted-request text attachments, never arbitrary
 * mentioned files. Bounded to six files / 64 KiB each; no code or tool execution. */
export async function expandPastedRequests(turns: RecordValue[], attachmentRoot = path.join(process.env.CODEX_HOME || path.join(homedir(), '.codex'), 'attachments'), operation?: CodexOperationGuard): Promise<string[]> {
  checkCodexOperation(operation);
  const gaps = new Set<string>(); let attempts = 0;
  for (const turn of turns) {
    for (const raw of Array.isArray(turn.items) ? turn.items : []) {
      const item = record(raw);
      if (item.type !== 'userMessage' || !Array.isArray(item.content)) continue;
      const content = item.content.map(record);
      const message = content.filter(part => part.type === 'text').map(part => typeof part.text === 'string' ? part.text : '').join('\n');
      if (!/^# Files pasted by the user:\s*$/m.test(message) || !message.includes("Pasted text contains the user's request.")) continue;
      const header = message.split('## My request:')[0];
      const paths = [...header.matchAll(/^## [^\r\n]+: ([^\r\n]+\.txt)\s*$/gm)].map(match => match[1].trim());
      if (!paths.length) gaps.add('粘贴请求的附件引用格式无法识别，未读取任意提及文件。');
      for (const reference of [...new Set(paths)]) {
        checkCodexOperation(operation);
        if (++attempts > 6) { gaps.add('粘贴文本附件超过本次六个文件的预算，未全部覆盖。'); continue; }
        try {
          const file = path.resolve(reference);
          if (!path.isAbsolute(reference) || !within(path.resolve(attachmentRoot), file)) throw new Error('attachment_boundary');
          const root = await fs.realpath(attachmentRoot); checkCodexOperation(operation);
          const resolved = await fs.realpath(file); checkCodexOperation(operation);
          if (!within(root, resolved) || path.extname(resolved).toLowerCase() !== '.txt') throw new Error('attachment_boundary');
          const handle = await fs.open(resolved, 'r');
          try {
            checkCodexOperation(operation);
            const info = await handle.stat(); checkCodexOperation(operation); if (!info.isFile()) throw new Error('attachment_boundary');
            const buffer = Buffer.alloc(65_536); const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
            checkCodexOperation(operation);
            if (info.size > bytesRead) gaps.add('粘贴文本超过单文件 64 KiB 预算，正文已截取。');
            const body = buffer.subarray(0, bytesRead).toString('utf8').replace(/^\uFEFF/, '');
            if (body.includes('\u0000')) throw new Error('attachment_format');
            if (!body.trim()) { gaps.add('部分粘贴请求附件为空，未据此生成正文或成果。'); continue; }
            item.content.push({ type: 'text', text: `\n粘贴文本（用户请求附件，不是已交付成果）：\n${body}` });
          } finally { await handle.close(); }
        } catch { checkCodexOperation(operation); gaps.add('部分粘贴请求附件不可访问或不在允许的文本附件目录；未推断其内容。'); }
      }
    }
  }
  checkCodexOperation(operation); return [...gaps];
}
