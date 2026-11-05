import type { BypassProbeResult } from './bypass-health';

export type WatchdogOutput = (text: string, level: 'info' | 'success' | 'warn' | 'error') => void;

/** off — обход не должен работать; checking — ещё не проверяли или нет сети */
export type WatchdogHealth = 'off' | 'checking' | 'ok' | 'degraded' | 'recovering' | 'down';

export type WatchdogEventKind = 'crashed' | 'blocked' | 'restored' | 'switched' | 'gave-up';

export interface WatchdogEvent {
  kind: WatchdogEventKind;
  text: string;
  strategy?: string;
}

export interface BypassWatchdogOptions {
  intervalMs?: number;
  healthCheckIntervalMs?: number;
  maxAttempts?: number;
  windowMs?: number;
  cooldownMs?: number;
  /** сколько раз перезапускать тот же конфиг, прежде чем перейти на запасной */
  restartsBeforeSwitch?: number;
  /** сколько запасных конфигов из рейтинга пробовать до быстрого подбора */
  maxFallbacks?: number;
  /** пауза после запуска winws перед проверкой сайтов */
  settleMs?: number;
  isStoppedByUser: () => boolean;
  autoRecoverEnabled: () => boolean;
  autoSwitchEnabled: () => boolean;
  /** идёт подбор конфига или обновление — сторож не вмешивается */
  isBusy: () => boolean;
  isOnline: () => boolean;
  verifyRunning: () => Promise<{ running: boolean; pid?: number | null }>;
  resolveZapretPath: () => Promise<string | null>;
  resolveStrategy: (root: string) => Promise<string | null>;
  probe: (root: string, strategy: string) => Promise<BypassProbeResult>;
  /** что именно не открылось при последней проверке */
  describeProbeFailure?: () => string;
  restartBypass: (root: string, strategy: string) => Promise<void>;
  /** следующий конфиг по рейтингу, кроме отложенных и уже испробованных */
  nextFallbackStrategy: (root: string, tried: string[]) => Promise<string | null>;
  markStrategyBad: (root: string, strategy: string) => void;
  /** быстрый подбор в фоне; возвращает лучший конфиг или null */
  quickPickStrategy: (root: string) => Promise<string | null>;
  onStrategySwitched: (strategy: string, previous: string) => void;
  onOutput: WatchdogOutput;
  onRecovered: () => void;
  onGiveUp: () => void;
  onEvent?: (event: WatchdogEvent) => void;
  onHealth?: (health: WatchdogHealth) => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

type TryResult = BypassProbeResult | 'aborted';

export class BypassWatchdog {
  private timer: ReturnType<typeof setInterval> | null = null;
  private expectedRunning = false;
  private recoveryInFlight = false;
  private recoveryAttempts = 0;
  private recoveryWindowStart = 0;
  private sameStrategyFailures = 0;
  private lastHealthCheckAt = 0;
  private healthFailStreak = 0;
  private tickInFlight = false;
  private health: WatchdogHealth = 'off';

  constructor(private readonly options: BypassWatchdogOptions) {}

  get isRecovering(): boolean {
    return this.recoveryInFlight;
  }

  get currentHealth(): WatchdogHealth {
    return this.health;
  }

  setExpected(running: boolean): void {
    this.expectedRunning = running;
    if (running) {
      this.recoveryAttempts = 0;
      this.recoveryWindowStart = this.now();
      this.sameStrategyFailures = 0;
      this.healthFailStreak = 0;
      this.lastHealthCheckAt = 0;
      this.setHealth('checking');
    } else {
      this.setHealth('off');
    }
  }

  /** После сна или смены сети она поднимается не сразу — не считаем это поломкой обхода */
  deferHealthCheck(ms = 30_000): void {
    this.healthFailStreak = 0;
    this.sameStrategyFailures = 0;
    this.lastHealthCheckAt = this.now() + ms;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      if (this.tickInFlight) return;
      this.tickInFlight = true;
      void this.tick().finally(() => {
        this.tickInFlight = false;
      });
    }, this.options.intervalMs ?? 8_000);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async tick(): Promise<void> {
    const o = this.options;
    if (!this.canRecover() || o.isBusy() || this.recoveryInFlight) return;

    const state = await o.verifyRunning();
    if (!state.running) {
      this.healthFailStreak = 0;
      this.emit({ kind: 'crashed', text: 'winws.exe не запущен' });
      await this.recover('winws не запущен');
      return;
    }

    const healthInterval = o.healthCheckIntervalMs ?? 30_000;
    const now = this.now();
    if (now - this.lastHealthCheckAt < healthInterval) return;
    this.lastHealthCheckAt = now;

    // Нет сети вообще — перезапуск winws не поможет
    if (!o.isOnline()) {
      this.healthFailStreak = 0;
      this.setHealth('checking');
      return;
    }

    const root = await o.resolveZapretPath();
    const strategy = root ? await o.resolveStrategy(root) : null;
    if (!root || !strategy) return;

    const result = await o.probe(root, strategy);
    if (result !== 'blocked') {
      this.healthFailStreak = 0;
      if (result === 'ok') this.recoveryAttempts = 0;
      this.setHealth(result === 'ok' ? 'ok' : 'checking');
      return;
    }

    this.healthFailStreak += 1;
    this.setHealth('degraded');
    if (this.healthFailStreak < 2) {
      o.onOutput(`${this.probeFailure()} — проверю ещё раз`, 'warn');
      return;
    }

    this.healthFailStreak = 0;
    this.emit({ kind: 'blocked', text: 'Сайты перестали открываться', strategy });
    await this.recover('Сайты недоступны');
  }

  private probeFailure(): string {
    return this.options.describeProbeFailure?.() || 'Сайты не открылись';
  }

  private canRecover(): boolean {
    const o = this.options;
    return this.expectedRunning && !o.isStoppedByUser() && o.autoRecoverEnabled();
  }

  private async recover(reason: string): Promise<void> {
    const o = this.options;
    if (this.recoveryInFlight || !this.canRecover()) return;

    const windowMs = o.windowMs ?? 10 * 60_000;
    const maxAttempts = o.maxAttempts ?? 8;
    if (this.now() - this.recoveryWindowStart > windowMs) {
      this.recoveryAttempts = 0;
      this.sameStrategyFailures = 0;
      this.recoveryWindowStart = this.now();
    }
    if (this.recoveryAttempts >= maxAttempts) {
      this.giveUp('Автовосстановление остановлено');
      return;
    }

    this.recoveryInFlight = true;
    this.recoveryAttempts += 1;
    this.setHealth('recovering');
    try {
      o.onOutput(`${reason} (${this.recoveryAttempts}/${maxAttempts})...`, 'warn');
      await this.sleep(o.cooldownMs ?? 2_000);
      if (!this.canRecover()) return;

      const root = await o.resolveZapretPath();
      if (!root || !this.canRecover()) return;

      const strategy = await o.resolveStrategy(root);
      if (!strategy || !this.canRecover()) return;

      const restartsBeforeSwitch = o.restartsBeforeSwitch ?? 2;
      if (this.sameStrategyFailures < restartsBeforeSwitch || !o.autoSwitchEnabled()) {
        this.sameStrategyFailures += 1;
        const result = await this.tryStrategy(root, strategy);
        if (result === 'ok') {
          const check = await o.verifyRunning();
          o.onOutput(`Обход восстановлен (PID ${check.pid ?? '?'})`, 'success');
          this.healthFailStreak = 0;
          this.recoveryAttempts = Math.max(0, this.recoveryAttempts - 1);
          this.setHealth('ok');
          this.emit({ kind: 'restored', text: 'Обход перезапущен', strategy });
          o.onRecovered();
          return;
        }
        if (result === 'aborted' || result === 'offline') return;
        o.onOutput(`Перезапуск не помог. ${this.probeFailure()}`, 'warn');
        // Последний перезапуск не помог — сразу ищем замену, не дожидаясь следующей проверки
        if (this.sameStrategyFailures < restartsBeforeSwitch || !o.autoSwitchEnabled()) return;
      }

      await this.switchStrategy(root, strategy);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      o.onOutput(`Автовосстановление не удалось: ${message}`, 'warn');
    } finally {
      this.recoveryInFlight = false;
      if (this.health === 'recovering') this.setHealth(this.expectedRunning ? 'degraded' : 'off');
    }
  }

  private async switchStrategy(root: string, failed: string): Promise<void> {
    const o = this.options;
    o.onOutput(`Конфиг ${strategyLabel(failed)} перестал работать, ищу замену...`, 'warn');
    o.markStrategyBad(root, failed);

    const tried = [failed];
    const maxFallbacks = o.maxFallbacks ?? 4;
    for (let i = 0; i < maxFallbacks; i += 1) {
      if (!this.canRecover()) return;
      const next = await o.nextFallbackStrategy(root, tried);
      if (!next) break;
      tried.push(next);

      o.onOutput(`Пробую запасной конфиг ${strategyLabel(next)}...`, 'info');
      const result = await this.tryStrategy(root, next);
      if (result === 'ok') {
        this.onSwitched(next, failed);
        return;
      }
      // Пропала сеть — дальше перебирать бессмысленно, разберёмся на следующей проверке
      if (result === 'aborted' || result === 'offline') return;
      o.markStrategyBad(root, next);
    }

    if (!this.canRecover()) return;
    o.onOutput('Запасные конфиги не помогли, запускаю быстрый подбор...', 'warn');
    const picked = await o.quickPickStrategy(root);
    if (!this.canRecover()) return;
    if (picked) {
      const result = await this.tryStrategy(root, picked);
      if (result === 'ok') {
        this.onSwitched(picked, failed);
        return;
      }
      if (result === 'aborted' || result === 'offline') return;
    }

    this.giveUp('Рабочий конфиг не найден, автовосстановление остановлено');
  }

  private async tryStrategy(root: string, strategy: string): Promise<TryResult> {
    const o = this.options;
    try {
      await o.restartBypass(root, strategy);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      o.onOutput(`Не удалось запустить ${strategyLabel(strategy)}: ${message}`, 'warn');
      return this.canRecover() ? 'blocked' : 'aborted';
    }
    if (!this.canRecover()) return 'aborted';

    const check = await o.verifyRunning();
    if (!check.running) return 'blocked';

    // winws нужно пару секунд, чтобы перехватить трафик
    await this.sleep(o.settleMs ?? 2_000);
    if (!this.canRecover()) return 'aborted';
    return o.probe(root, strategy);
  }

  private onSwitched(strategy: string, previous: string): void {
    const o = this.options;
    this.sameStrategyFailures = 0;
    this.healthFailStreak = 0;
    this.recoveryAttempts = 0;
    this.recoveryWindowStart = this.now();
    this.setHealth('ok');
    o.onOutput(`Переключился на конфиг ${strategyLabel(strategy)}`, 'success');
    this.emit({
      kind: 'switched',
      text: `${strategyLabel(previous)} → ${strategyLabel(strategy)}`,
      strategy,
    });
    o.onStrategySwitched(strategy, previous);
  }

  private giveUp(message: string): void {
    const o = this.options;
    this.expectedRunning = false;
    this.setHealth('down');
    this.emit({ kind: 'gave-up', text: message });
    o.onGiveUp();
    o.onOutput(message, 'warn');
  }

  private setHealth(health: WatchdogHealth): void {
    if (this.health === health) return;
    this.health = health;
    this.options.onHealth?.(health);
  }

  private emit(event: WatchdogEvent): void {
    this.options.onEvent?.(event);
  }

  private sleep(ms: number): Promise<void> {
    if (this.options.sleep) return this.options.sleep(ms);
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private now(): number {
    return this.options.now ? this.options.now() : Date.now();
  }
}

export function strategyLabel(strategy: string): string {
  return strategy.replace(/\.bat$/i, '');
}
