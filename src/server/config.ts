import { createHash } from 'node:crypto';
import path from 'node:path';
import { isPackagedTrial } from './trialDiagnostics.js';
import { loadFeedbackPublicConfig, type FeedbackPublicConfig } from './feedback.js';

export interface AppConfig {
  host: string;
  port: number;
  dataDir: string;
  databasePath: string;
  skinDir: string;
  codexCliPath: string;
  demoMode: boolean;
  runtime: string;
  packagedRuntime?: string;
  projectRoot?: string;
  trialDiagnostics?: boolean;
  feedback?: FeedbackPublicConfig;
}

export function loadConfig(env = process.env): AppConfig {
  const dataDir = path.resolve(env.ZZ_BOARD_DATA_DIR || path.join(process.cwd(), '.local-data'));
  const runtime = env.ZZ_BOARD_RUNTIME?.trim() || 'web-fallback';
  const slot = env.ZZ_BOARD_PACKAGED_RUNTIME;
  return {
    host: env.ZZ_BOARD_HOST || '127.0.0.1',
    port: parsePort(env.ZZ_BOARD_PORT),
    dataDir,
    databasePath: path.join(dataDir, 'zz-board.sqlite'),
    skinDir: path.join(dataDir, 'skins'),
    codexCliPath: env.CODEX_CLI_PATH || 'codex',
    demoMode: env.ZZ_BOARD_DEMO === '1',
    runtime,
    packagedRuntime: runtime === 'desktop-sidecar' && slot && /^(?:zzb-runtime-[a-f0-9]{64}|development)$/.test(slot) ? slot : undefined,
    feedback: loadFeedbackPublicConfig(env),
    ...(isPackagedTrial(env) ? { trialDiagnostics: true } : {}),
    projectRoot: env.ZZ_BOARD_PROJECT_ROOT && path.isAbsolute(env.ZZ_BOARD_PROJECT_ROOT) ? path.resolve(env.ZZ_BOARD_PROJECT_ROOT) : undefined
  };
}

function parsePort(value: string | undefined): number {
  const port = Number(value || 4318);
  return Number.isInteger(port) && port > 0 && port < 65_536 ? port : 4318;
}

export function dataStoreId(dataDir: string): string {
  const normalized = path.resolve(dataDir).replaceAll('\\', '/').toLowerCase();
  return createHash('sha256').update(normalized).digest('hex').slice(0, 16);
}
