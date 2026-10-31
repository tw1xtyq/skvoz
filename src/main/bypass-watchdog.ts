import { net, powerMonitor } from 'electron';
import { verifyBypassRunning } from './zapret';
import { probeBypassReachability } from './bypass-health';

export type WatchdogOutput = (text: string, level: 'info' | 'success' | 'warn' | 'error') => void;

export interface BypassWatchdogOptions {
  intervalMs?: number;
  healthCheckIntervalMs?: number;
  maxAttempts?: number;
  windowMs?: number;
  cooldownMs?: number;
  isStoppedByUser: () => boolean;
  autoRecoverEnabled: () => boolean;
  resolveZapretPath: () => Promise<string | null>;
  resolveStrategy: (root: string) => Promise<string | null>;
  restartBypass: (root: string, strategy: string) => Promise<void>;
  onOutput: WatchdogOutput;
  onRecovered: () => void;
  onGiveUp: () => void;
}

let timer: ReturnType<typeof setInterval> | null = null;
let expectedRunning = false;
let recoveryInFlight = false;
let recoveryAttempts = 0;
let recoveryWindowStart = 0;
let lastHealthCheckAt = 0;
let healthFailStreak = 0;
let tickInFlight = false;
let resumeHooked = false;
let options: BypassWatchdogOptions | null = null;

export function configureBypassWatchdog(next: BypassWatchdogOptions): void {
  options = next;
}

export function setBypassWatchdogExpected(running: boolean): void {
  expectedRunning = running;
  if (running) {
    recoveryAttempts = 0;
    recoveryWindowStart = Date.now();
    healthFailStreak = 0;
    lastHealthCheckAt = 0;
  }
}

function canRecoverBypass(): boolean {
  return !!options && expectedRunning && !options.isStoppedByUser() && options.autoRecoverEnabled();
}

export function startBypassWatchdog(): void {
  if (timer || !options) return;
  if (!resumeHooked) {
    resumeHooked = true;
    // После сна сеть поднимается не сразу — не считаем это поломкой обхода
    powerMonitor.on('resume', () => {
      healthFailStreak = 0;
      lastHealthCheckAt = Date.now() + 30_000;
    });
  }
  timer = setInterval(() => {
    if (tickInFlight) return;
    tickInFlight = true;
    void tickBypassWatchdog().finally(() => {
      tickInFlight = false;
    });
  }, options.intervalMs ?? 8_000);
}

export function stopBypassWatchdog(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

async function tickBypassWatchdog(): Promise<void> {
  if (!options || !expectedRunning || options.isStoppedByUser() || !options.autoRecoverEnabled()) {
    return;
  }
  if (recoveryInFlight) return;

  const state = await verifyBypassRunning();
  if (!state.running) {
    healthFailStreak = 0;
    await recoverBypass('winws не запущен');
    return;
  }

  const healthInterval = options.healthCheckIntervalMs ?? 30_000;
  const now = Date.now();
  if (now - lastHealthCheckAt < healthInterval) return;
  lastHealthCheckAt = now;

  // Нет сети вообще — перезапуск winws не поможет
  if (!net.isOnline()) {
    healthFailStreak = 0;
    return;
  }

  const reachable = await probeBypassReachability();
  if (reachable) {
    healthFailStreak = 0;
    recoveryAttempts = 0;
    return;
  }

  healthFailStreak += 1;
  if (healthFailStreak < 2) {
    options.onOutput('Проверка не прошла', 'warn');
    return;
  }

  healthFailStreak = 0;
  await recoverBypass('Сайты недоступны');
}

async function recoverBypass(reason: string): Promise<void> {
  if (!options || recoveryInFlight || !canRecoverBypass()) return;

  const windowMs = options.windowMs ?? 10 * 60_000;
  const maxAttempts = options.maxAttempts ?? 8;
  if (Date.now() - recoveryWindowStart > windowMs) {
    recoveryAttempts = 0;
    recoveryWindowStart = Date.now();
  }
  if (recoveryAttempts >= maxAttempts) {
    expectedRunning = false;
    options.onGiveUp();
    options.onOutput('Автовосстановление остановлено', 'warn');
    return;
  }

  recoveryInFlight = true;
  recoveryAttempts += 1;
  try {
    options.onOutput(`${reason} (${recoveryAttempts}/${maxAttempts})...`, 'warn');
    await delay(options.cooldownMs ?? 2_000);
    if (!canRecoverBypass()) return;

    const root = await options.resolveZapretPath();
    if (!root || !canRecoverBypass()) return;

    const strategy = await options.resolveStrategy(root);
    if (!strategy || !canRecoverBypass()) return;

    await options.restartBypass(root, strategy);
    if (!canRecoverBypass()) return;

    const check = await verifyBypassRunning();
    if (!check.running) return;

    const reachable = await probeBypassReachability(5_000);
    if (reachable) {
      options.onOutput(`Обход восстановлен (PID ${check.pid ?? '?'})`, 'success');
      healthFailStreak = 0;
      recoveryAttempts = Math.max(0, recoveryAttempts - 1);
      options.onRecovered();
      return;
    }

    options.onOutput('Перезапуск выполнен, проверка не прошла', 'warn');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    options.onOutput(`Автовосстановление не удалось: ${message}`, 'warn');
  } finally {
    recoveryInFlight = false;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
