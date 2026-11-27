/** Synthetic quality gate only. Dry run is default; no board DB is opened. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { summaryQualityCases } from '../tests/fixtures/summaryQuality.js';
import { summaryPrompt, validateSummary, validateMilestoneEvidence, modelSummarySchema } from '../src/server/summaryJobs.js';
import { DEFAULT_SUMMARY_SETTINGS, SUMMARY_PROMPT_VERSION, type SummaryUsage } from '../src/shared/summarySync.js';
import { CodexSummaryRuntime, SummaryRuntimeError } from '../src/server/codex/summaryRuntime.js';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const outputRoot = path.join(root, '.tmp', 'summary-quality');
const args = process.argv.slice(2).filter(arg => arg !== '--');
const flags = ['--codex', '--model', '--effort', '--cases'];
const allowed = args.every((arg, i) => arg === '--apply' || flags.includes(arg) || flags.includes(args[i - 1]!));
if (!allowed || flags.some(flag => args.filter(arg => arg === flag).length > 1 || args.includes(flag) && (!args[args.indexOf(flag) + 1] || args[args.indexOf(flag) + 1]!.startsWith('--')))) throw new Error('只接受 --apply、--codex、--model、--effort、--cases；不接受数据库或正式数据目录。');
const option = (key: string, fallback: string) => args.includes(key) ? args[args.indexOf(key) + 1]! : fallback;
const settings = { model: option('--model', DEFAULT_SUMMARY_SETTINGS.model), effort: option('--effort', DEFAULT_SUMMARY_SETTINGS.effort) };
const selected = option('--cases', '').split(',').filter(Boolean);
const cases = selected.length ? summaryQualityCases.filter(test => selected.includes(test.id)) : summaryQualityCases;
if (selected.some(id => !summaryQualityCases.some(test => test.id === id))) throw new Error('Unknown synthetic case.');
const sources = cases.flatMap(test => test.sources);
const promptChars = sources.reduce((total, source) => total + summaryPrompt(source, undefined, []).length, 0);
const preview = { mode: args.includes('--apply') ? 'apply' : 'preview', ...settings, cases: cases.length, summaryCalls: sources.length, promptCharacters: promptChars, estimatedInputTokens: [Math.ceil(promptChars / 3), promptChars], estimatedOutputAndReasoningTokens: [sources.length * 1000, sources.length * 6000], note: '仅为合成用例预算，不含运行时协议开销；实际用量以运行时返回为准。未传 --apply 时不启动 Codex、不读取真实历史、不写文件。' };
Object.assign(preview, { promptVersion: SUMMARY_PROMPT_VERSION });
console.log(JSON.stringify(preview, null, 2));
if (args.includes('--apply')) {
  if (path.dirname(outputRoot) !== path.join(root, '.tmp') || outputRoot.includes('.local-data')) throw new Error('质量验收目录不安全。');
  await fs.mkdir(outputRoot, { recursive: true });
  const runDir = await fs.mkdtemp(path.join(outputRoot, 'run-'));
  const executable = args.includes('--codex') ? args[args.indexOf('--codex') + 1] : process.env.CODEX_CLI_PATH || 'codex';
  // Keep the private runtime index across quality runs; per-run reports remain
  // separate. Rebuilding the index per report repeatedly scans local history.
  const runtime = new CodexSummaryRuntime(executable, outputRoot);
  const records: Array<Record<string, unknown>> = [];
  let runtimeBlocked = false;
  let totalUsage: SummaryUsage | null = null;
  let usageIncomplete = false;
  for (const test of cases) {
    for (const [sourceIndex, source] of test.sources.entries()) {
      try {
        const startedAt = Date.now();
        const result = await runtime.summarize({ ...settings, prompt: summaryPrompt(source, undefined, []), outputSchema: z.toJSONSchema(modelSummarySchema) });
        if (!result.usage) usageIncomplete = true;
        else if (!usageIncomplete) totalUsage = Object.fromEntries(Object.keys(result.usage).map(key => [key, (totalUsage?.[key as keyof SummaryUsage] ?? 0) + result.usage![key as keyof SummaryUsage]])) as unknown as SummaryUsage;
        if (usageIncomplete) totalUsage = null;
        let issues: string[]; let summary: unknown;
        try { summary = validateSummary(result.value, source); validateMilestoneEvidence((summary as ReturnType<typeof validateSummary>).milestones ?? [], source.evidence); issues = test.assert(sourceIndex, summary as ReturnType<typeof validateSummary>); }
        catch { issues = ['生产 schema 或证据引用／产物校验失败']; summary = result.value; }
        if (result.model !== settings.model) issues.push('实际模型与指定模型不一致');
        records.push({ case: test.id, sourceIndex, result: issues.length ? 'FAIL' : 'PASS', issues, actualModel: result.model, elapsedMs: Date.now() - startedAt, usage: result.usage, summary });
      } catch (error) {
        runtimeBlocked = true; totalUsage = null;
        records.push({ case: test.id, sourceIndex, result: 'BLOCKED', code: error instanceof SummaryRuntimeError ? error.code : 'unexpected_runtime_failure' });
        break;
      }
    }
    if (runtimeBlocked) break;
  }
  const completedSources = records.filter(record => record.result !== 'BLOCKED').length;
  const report = { ...preview, completedAt: new Date().toISOString(), result: runtimeBlocked ? 'BLOCKED' : records.some(record => record.result !== 'PASS') ? 'FAIL' : 'PASS', safety: runtime.status(), records, actualUsage: totalUsage, completedSources, remainingSources: sources.length - completedSources, semanticReview: '自动断言只覆盖预定义错误；仍需人工审阅生成的合成摘要，不能据此宣称普遍无幻觉或真实项目验收通过。' };
  const reportPath = path.join(runDir, 'report.json');
  await fs.writeFile(reportPath, JSON.stringify(report, null, 2), { encoding: 'utf8', flag: 'wx' });
  console.log(JSON.stringify({ result: report.result, reportPath, completedSources, remainingSources: report.remainingSources, actualUsage: totalUsage }, null, 2));
  if (report.result !== 'PASS') process.exitCode = 1;
}
