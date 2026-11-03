import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { isWindowsAdmin } from './admin';
import type { OutputCallback } from './diagnostics';
import { runHidden } from './exec';
import { startBypassHidden } from './service-actions';

export const TEST_PROGRESS_PREFIX = '__TEST_PROGRESS__:';
export const TEST_RESULT_PREFIX = '__TEST_RESULT__:';
export const TEST_STRATEGY_DONE_PREFIX = '__TEST_STRATEGY_DONE__:';

export interface TestTarget {
  name: string;
  url?: string;
  ping?: string;
}

export interface StrategyRanking {
  strategy: string;
  score: number;
  maxScore: number;
  okChecks: number;
  totalChecks: number;
  /** цели, где не прошла ни одна проверка */
  failed: string[];
}

export class PickBestStrategyCancelledError extends Error {
  constructor() {
    super('PICK_BEST_CANCELLED');
    this.name = 'PickBestStrategyCancelledError';
  }
}

export interface PickBestStrategyOptions {
  emitUiEvents?: boolean;
  shouldCancel?: () => boolean;
  /** остановиться на первом конфиге, прошедшем все проверки */
  quick?: boolean;
}

export interface PickBestStrategyOutcome {
  best: StrategyRanking | null;
  rankings: StrategyRanking[];
  cancelled: boolean;
  targetCount: number;
}

export interface TestResultPayload extends PickBestStrategyOutcome {
  quick: boolean;
}

function emit(out: OutputCallback, text: string, level: 'info' | 'success' | 'warn' | 'error' = 'info'): void {
  out({ text, level });
}

function runCmd(command: string, args: string[]): Promise<string> {
  const MAX_OUTPUT = 32 * 1024;
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, shell: false });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => {
      if (stdout.length < MAX_OUTPUT) stdout += d.toString();
    });
    child.stderr.on('data', (d) => {
      if (stderr.length < MAX_OUTPUT) stderr += d.toString();
    });
    child.on('close', (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(stderr.trim() || stdout.trim() || `Command failed: ${command}`));
    });
    child.on('error', reject);
  });
}

async function curlHead(url: string, extraArgs: string[] = []): Promise<'ok' | 'error' | 'unsup'> {
  try {
    const args = ['-I', '-s', '--connect-timeout', '4', '-m', '5', '-o', 'NUL', '-w', '%{http_code}', ...extraArgs, url];
    const output = (await runCmd('curl.exe', args)).trim();
    if (/^\d{3}$/.test(output)) return 'ok';
    return 'error';
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/does not support|unsupported|UNSUP|35/i.test(msg)) return 'unsup';
    return 'error';
  }
}

function checkScore(value: 'ok' | 'error' | 'unsup'): number {
  if (value === 'ok') return 2;
  if (value === 'unsup') return 1;
  return 0;
}

function targetMaxScore(target: TestTarget): number {
  if (target.url) return 6;
  if (target.ping) return 2;
  return 0;
}

async function pingHost(host: string): Promise<'ok' | 'error'> {
  try {
    const output = await runCmd('ping', ['-n', '2', '-w', '1500', host]);
    return /TTL=/i.test(output) ? 'ok' : 'error';
  } catch {
    return 'error';
  }
}

export function loadTargets(root: string): TestTarget[] {
  const file = path.join(root, 'utils', 'targets.txt');
  const targets: TestTarget[] = [];

  if (fs.existsSync(file)) {
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const match = line.match(/^\s*([\w\s]+?)\s*=\s*"(.+)"\s*$/);
      if (!match) continue;
      const value = match[2];
      if (value.startsWith('PING:')) {
        targets.push({ name: match[1].trim(), ping: value.replace(/^PING:\s*/, '') });
      } else {
        targets.push({ name: match[1].trim(), url: value });
      }
    }
  }

  if (targets.length === 0) {
    return [
      { name: 'Discord', url: 'https://discord.com' },
      { name: 'Discord Gateway', url: 'https://gateway.discord.gg' },
      { name: 'YouTube', url: 'https://www.youtube.com' },
      { name: 'Google', url: 'https://www.google.com' },
      { name: 'Cloudflare DNS', ping: '1.1.1.1' },
    ];
  }

  return targets;
}

function listStrategies(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root)
    .filter((f) => f.endsWith('.bat') && !f.toLowerCase().startsWith('service'))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

function sortStrategiesForTest(strategies: string[]): string[] {
  return [...strategies].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

function compareStrategyRankings(a: StrategyRanking, b: StrategyRanking): number {
  const scoreDiff = b.score - a.score;
  if (scoreDiff !== 0) return scoreDiff;
  if (b.okChecks !== a.okChecks) return b.okChecks - a.okChecks;
  return 0;
}

async function stopWinws(): Promise<void> {
  try {
    await runHidden('taskkill', ['/IM', 'winws.exe', '/F'], { timeoutMs: 10_000 });
  } catch {
    /* already stopped */
  }
}

async function isWinwsRunning(): Promise<boolean> {
  try {
    const output = await runCmd('tasklist', ['/FI', 'IMAGENAME eq winws.exe', '/FO', 'CSV', '/NH']);
    return /^"winws\.exe"/im.test(output);
  } catch {
    return false;
  }
}

async function delayMs(ms: number, shouldCancel?: () => boolean): Promise<void> {
  const step = 200;
  for (let waited = 0; waited < ms; waited += step) {
    if (shouldCancel?.()) {
      throw new PickBestStrategyCancelledError();
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(step, ms - waited)));
  }
}

async function testStrategy(
  root: string,
  strategy: string,
  targets: TestTarget[],
  out: OutputCallback,
  shouldCancel?: () => boolean,
  index?: { current: number; total: number }
): Promise<StrategyRanking> {
  const startedAt = Date.now();
  await stopWinws();
  if (shouldCancel?.()) throw new PickBestStrategyCancelledError();
  await startBypassHidden(root, strategy);
  await delayMs(3500, shouldCancel);

  // все цели проверяем параллельно: ~5 с на конфиг вместо минуты
  const perTarget = await Promise.all(
    targets.map(async (target) => {
      const checks = target.url
        ? await Promise.all([
            curlHead(target.url, ['--http1.1']),
            curlHead(target.url, ['--tlsv1.2', '--tls-max', '1.2']),
            curlHead(target.url, ['--tlsv1.3', '--tls-max', '1.3']),
          ])
        : target.ping
          ? [await pingHost(target.ping)]
          : [];
      return { target, checks };
    })
  );

  await stopWinws();
  if (shouldCancel?.()) throw new PickBestStrategyCancelledError();

  let score = 0;
  let okChecks = 0;
  let totalChecks = 0;
  let maxScore = 0;
  const failed: string[] = [];
  for (const { target, checks } of perTarget) {
    maxScore += targetMaxScore(target);
    totalChecks += checks.length;
    for (const val of checks) {
      score += checkScore(val);
      if (val === 'ok') okChecks += 1;
    }
    if (checks.length > 0 && !checks.includes('ok')) failed.push(target.name);
  }

  const ranking: StrategyRanking = { strategy, score, maxScore, okChecks, totalChecks, failed };
  const pct = rankingPct(ranking);
  emit(
    out,
    `${TEST_STRATEGY_DONE_PREFIX}${JSON.stringify({
      strategy,
      pct,
      okChecks,
      totalChecks,
      failed,
      ms: Date.now() - startedAt,
      current: index?.current ?? 1,
      total: index?.total ?? 1,
    })}`,
    pct >= 50 ? 'success' : 'warn'
  );

  return ranking;
}

export function rankingPct(ranking: StrategyRanking): number {
  return ranking.maxScore > 0 ? Math.round((ranking.score / ranking.maxScore) * 100) : 0;
}

async function checkPrerequisites(out?: OutputCallback): Promise<boolean> {
  if (!isWindowsAdmin()) {
    out?.({ text: '[X] Нужны права администратора. Запустите приложение от имени администратора.', level: 'error' });
    return false;
  }
  try {
    await runCmd('curl.exe', ['--version']);
  } catch {
    out?.({ text: '[X] curl.exe не найден в PATH', level: 'error' });
    return false;
  }
  return true;
}

export async function pickBestStrategy(
  root: string,
  out?: OutputCallback,
  options: PickBestStrategyOptions = {}
): Promise<PickBestStrategyOutcome> {
  const emitUiEvents = options.emitUiEvents ?? true;
  const shouldCancel = options.shouldCancel ?? (() => false);
  const empty: PickBestStrategyOutcome = { best: null, rankings: [], cancelled: false, targetCount: 0 };

  if (shouldCancel()) return { ...empty, cancelled: true };
  if (!(await checkPrerequisites(out))) return empty;

  if (await isWinwsRunning()) {
    await stopWinws();
  }

  const strategies = sortStrategiesForTest(listStrategies(root));
  if (strategies.length === 0) {
    out?.({ text: '[X] Стратегии (.bat) не найдены', level: 'error' });
    return empty;
  }

  if (strategies.length === 1) {
    const only: StrategyRanking = {
      strategy: strategies[0],
      score: 0,
      maxScore: 0,
      okChecks: 0,
      totalChecks: 0,
      failed: [],
    };
    return { best: only, rankings: [only], cancelled: false, targetCount: 0 };
  }

  const targets = loadTargets(root);
  const rankings: StrategyRanking[] = [];
  let cancelled = false;

  for (let i = 0; i < strategies.length; i += 1) {
    if (shouldCancel()) {
      cancelled = true;
      break;
    }

    const strategy = strategies[i];
    if (emitUiEvents) {
      out?.({
        text: `${TEST_PROGRESS_PREFIX}${JSON.stringify({ current: i + 1, total: strategies.length, strategy })}`,
        level: 'info',
      });
    } else {
      out?.({
        text: `Проверка конфига ${strategy.replace('.bat', '')} (${i + 1}/${strategies.length})...`,
        level: 'info',
      });
    }

    try {
      const ranking = await testStrategy(root, strategy, targets, out ?? (() => undefined), shouldCancel, {
        current: i + 1,
        total: strategies.length,
      });
      rankings.push(ranking);
      if (options.quick && ranking.maxScore > 0 && ranking.score === ranking.maxScore) {
        out?.({
          text: `Конфиг ${strategy.replace('.bat', '')} прошёл все проверки — подбор завершён`,
          level: 'success',
        });
        break;
      }
    } catch (error) {
      if (error instanceof PickBestStrategyCancelledError) {
        cancelled = true;
        break;
      }
      throw error;
    }
  }

  if (cancelled) await stopWinws();

  rankings.sort(compareStrategyRankings);
  const best = rankings[0] ?? null;
  const outcome: PickBestStrategyOutcome = { best, rankings, cancelled, targetCount: targets.length };

  if (emitUiEvents && best) {
    const payload: TestResultPayload = { ...outcome, quick: !!options.quick };
    out?.({ text: `${TEST_RESULT_PREFIX}${JSON.stringify(payload)}`, level: 'info' });
  }

  return outcome;
}

export async function runTestsInApp(
  root: string,
  strategyFile: string | null,
  mode: 'current' | 'all',
  out: OutputCallback
): Promise<void> {
  if (mode === 'all') {
    await pickBestStrategy(root, out, { emitUiEvents: true });
    return;
  }

  if (!(await checkPrerequisites(out))) return;

  if (await isWinwsRunning()) {
    await stopWinws();
  }

  const strategy =
    strategyFile && fs.existsSync(path.join(root, strategyFile)) ? strategyFile : listStrategies(root)[0];
  if (!strategy) {
    emit(out, '[X] Стратегии (.bat) не найдены', 'error');
    return;
  }

  const targets = loadTargets(root);
  emit(out, `${TEST_PROGRESS_PREFIX}${JSON.stringify({ current: 1, total: 1, strategy })}`, 'info');
  const ranking = await testStrategy(root, strategy, targets, out);
  const payload: TestResultPayload = {
    rankings: [ranking],
    best: ranking,
    cancelled: false,
    targetCount: targets.length,
    quick: false,
  };
  emit(out, `${TEST_RESULT_PREFIX}${JSON.stringify(payload)}`, 'info');
}
