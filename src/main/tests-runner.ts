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
}

export interface TestResultPayload {
  rankings: StrategyRanking[];
  best: StrategyRanking | null;
  targetCount: number;
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
    const args = ['-I', '-s', '-m', '5', '-o', 'NUL', '-w', '%{http_code}', ...extraArgs, url];
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
    const script = `(Test-Connection -ComputerName '${host.replace(/'/g, "''")}' -Count 2 -ErrorAction Stop | Measure-Object -Property ResponseTime -Average).Average`;
    const output = await runPowerShell(script);
    const avg = parseFloat(output.trim());
    return Number.isFinite(avg) ? 'ok' : 'error';
  } catch {
    return 'error';
  }
}

function runPowerShell(script: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { windowsHide: true }
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    child.on('close', (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(stderr.trim() || `PowerShell exited with code ${code}`));
    });
    child.on('error', reject);
  });
}

function loadTargets(root: string): TestTarget[] {
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
  shouldCancel?: () => boolean
): Promise<StrategyRanking> {
  let score = 0;
  let okChecks = 0;
  let totalChecks = 0;
  let maxScore = 0;

  await stopWinws();
  if (shouldCancel?.()) throw new PickBestStrategyCancelledError();
  await startBypassHidden(root, strategy);
  await delayMs(3500, shouldCancel);

  for (const target of targets) {
    if (shouldCancel?.()) {
      await stopWinws();
      throw new PickBestStrategyCancelledError();
    }

    maxScore += targetMaxScore(target);

    if (target.url) {
      const http = await curlHead(target.url, ['--http1.1']);
      const tls12 = await curlHead(target.url, ['--tlsv1.2', '--tls-max', '1.2']);
      const tls13 = await curlHead(target.url, ['--tlsv1.3', '--tls-max', '1.3']);
      for (const val of [http, tls12, tls13]) {
        totalChecks += 1;
        score += checkScore(val);
        if (val === 'ok') okChecks += 1;
      }
    } else if (target.ping) {
      const ping = await pingHost(target.ping);
      totalChecks += 1;
      score += checkScore(ping);
      if (ping === 'ok') okChecks += 1;
    }
  }

  await stopWinws();

  const ranking: StrategyRanking = {
    strategy,
    score,
    maxScore,
    okChecks,
    totalChecks,
  };

  const pct = ranking.maxScore > 0 ? Math.round((ranking.score / ranking.maxScore) * 100) : 0;
  emit(
    out,
    `${TEST_STRATEGY_DONE_PREFIX}${JSON.stringify({ strategy, pct, okChecks, totalChecks })}`,
    pct >= 50 ? 'success' : 'warn'
  );

  return ranking;
}

export async function pickBestStrategy(
  root: string,
  out?: OutputCallback,
  options: PickBestStrategyOptions = {}
): Promise<StrategyRanking | null> {
  const emitUiEvents = options.emitUiEvents ?? true;
  const shouldCancel = options.shouldCancel ?? (() => false);

  if (shouldCancel()) throw new PickBestStrategyCancelledError();

  if (!isWindowsAdmin()) {
    out?.({ text: '[X] Нужны права администратора. Запустите приложение от имени администратора.', level: 'error' });
    return null;
  }

  try {
    await runCmd('curl.exe', ['--version']);
  } catch {
    out?.({ text: '[X] curl.exe не найден в PATH', level: 'error' });
    return null;
  }

  if (await isWinwsRunning()) {
    await stopWinws();
  }

  const strategies = listStrategies(root);
  if (strategies.length === 0) {
    out?.({ text: '[X] Стратегии (.bat) не найдены', level: 'error' });
    return null;
  }

  if (strategies.length === 1) {
    return {
      strategy: strategies[0],
      score: 0,
      maxScore: 0,
      okChecks: 0,
      totalChecks: 0,
    };
  }

  const targets = loadTargets(root);
  const rankings: StrategyRanking[] = [];

  for (let i = 0; i < strategies.length; i += 1) {
    if (shouldCancel()) {
      await stopWinws();
      throw new PickBestStrategyCancelledError();
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
    rankings.push(await testStrategy(root, strategy, targets, out ?? (() => undefined), shouldCancel));
  }

  rankings.sort((a, b) => b.score - a.score || b.okChecks - a.okChecks);
  const best = rankings[0] ?? null;

  if (emitUiEvents && best) {
    const payload: TestResultPayload = { rankings, best, targetCount: targets.length };
    out?.({ text: `${TEST_RESULT_PREFIX}${JSON.stringify(payload)}`, level: 'info' });
  }

  return best;
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

  if (!isWindowsAdmin()) {
    emit(out, '[X] Нужны права администратора. Запустите приложение от имени администратора.', 'error');
    return;
  }

  try {
    await runCmd('curl.exe', ['--version']);
  } catch {
    emit(out, '[X] curl.exe не найден в PATH', 'error');
    return;
  }

  if (await isWinwsRunning()) {
    await stopWinws();
  }

  const strategies =
    strategyFile && fs.existsSync(path.join(root, strategyFile))
      ? [strategyFile]
      : listStrategies(root).slice(0, 1);

  if (strategies.length === 0) {
    emit(out, '[X] Стратегии (.bat) не найдены', 'error');
    return;
  }

  const targets = loadTargets(root);
  const rankings: StrategyRanking[] = [];

  for (let i = 0; i < strategies.length; i += 1) {
    const strategy = strategies[i];
    emit(out, `${TEST_PROGRESS_PREFIX}${JSON.stringify({ current: i + 1, total: strategies.length, strategy })}`, 'info');
    rankings.push(await testStrategy(root, strategy, targets, out));
  }

  rankings.sort((a, b) => b.score - a.score || b.okChecks - a.okChecks);
  const best = rankings[0] ?? null;
  const payload: TestResultPayload = { rankings, best, targetCount: targets.length };
  emit(out, `${TEST_RESULT_PREFIX}${JSON.stringify(payload)}`, 'info');
}
