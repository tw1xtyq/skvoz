import type { BypassProbeResult } from './bypass-health';

export type WatchdogOutput = (text: string, level: 'info' | 'success' | 'warn' | 'error') => void;

/** off — обход не должен работать; checking — ещё не проверяли или нет сети */
export type WatchdogHealth = 'off' | 'checking' | 'ok' | 'degraded' | 'recovering' | 'down';

export type WatchdogEventKind = 'crashed' | 'blocked' | 'restored' | 'switched' | 'gave-up' | 'retry';

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
  /**
   * Через сколько после «сдался» пробовать снова: сайты часто чинятся сами
   * (провайдер откатил блокировку, сменилась сеть), и бросать обход навсегда нельзя.
   * Последнее значение повторяется. Пустой список — не повторять.
   */
  giveUpRetryMs?: number[];
  /** сколько обход должен проработать без сбоев, чтобы конфиг снова считался надёжным */
  stableAfterMs?: number;
  /**
   * Запущена игра: каждый перезапуск winws рвёт соединение с игровым сервером,
   * поэтому сайты проверяем редко, а конфиги не перебираем — только перезапуск текущего.
   */
  isGameMode?: () => boolean;
  /** как часто проверять сайты в игровом режиме */
  gameHealthCheckIntervalMs?: number;
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
  /** retryAt — когда сторож попробует снова, null — не попробует */
  onGiveUp: (retryAt: number | null) => void;
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
  private giveUpCount = 0;
  private retryAt: number | null = null;
  private lastRecoveryAt = 0;

  constructor(private readonly options: BypassWatchdogOptions) {}

  get isRecovering(): boolean {
    return this.recoveryInFlight;
  }

  get currentHealth(): WatchdogHealth {
    return this.health;
  }

  /** Когда сторож сам попробует снова после того, как сдался */
  get nextRetryAt(): number | null {
    return this.health === 'down' ? this.retryAt : null;
  }

  setExpected(running: boolean): void {
    this.expectedRunning = running;
    this.retryAt = null;
    if (running) {
      this.giveUpCount = 0;
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
    // новая сеть или пробуждение — повод не ждать полчаса, а попробовать скоро
    if (this.retryAt !== null) this.retryAt = Math.min(this.retryAt, this.now() + ms);
  }

  /**
   * «Починить сейчас» по кнопке: счётчики с нуля и тот же путь, что при сбое —
   * перезапуск, затем запасные конфиги и быстрый подбор.
   */
  async recoverNow(): Promise<void> {
    const o = this.options;
    if (this.recoveryInFlight) throw new Error('Обход уже восстанавливается');
    if (o.isBusy()) throw new Error('Сейчас идёт подбор конфига — попробуйте через минуту');
    if (o.isStoppedByUser()) throw new Error('Обход выключен — включите его');
    if (!o.autoRecoverEnabled()) throw new Error('Автовосстановление выключено в настройках');
    if (!o.isOnline()) throw new Error('Нет подключения к интернету');
    this.rearm();
    await this.recover('Восстановление по запросу');
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
    if (o.isBusy() || this.recoveryInFlight) return;
    if (this.health === 'down') {
      await this.retryAfterGiveUp();
      return;
    }
    if (!this.canRecover()) return;

    const state = await o.verifyRunning();
    if (!state.running) {
      this.healthFailStreak = 0;
      this.emit({ kind: 'crashed', text: 'winws.exe не запущен' });
      await this.recover('winws не запущен');
      return;
    }

    const healthInterval = this.inGame()
      ? o.gameHealthCheckIntervalMs ?? 5 * 60_000
      : o.healthCheckIntervalMs ?? 30_000;
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
      if (result === 'ok') {
        this.recoveryAttempts = 0;
        // конфиг давно работает без сбоев — прошлые перезапуски ему больше не припоминаем
        if (now - this.lastRecoveryAt >= (o.stableAfterMs ?? 5 * 60_000)) this.sameStrategyFailures = 0;
      }
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

  /** Сдался — но через паузу пробуем снова; если сайты уже открываются сами, просто отмечаем это */
  private async retryAfterGiveUp(): Promise<void> {
    const o = this.options;
    if (this.retryAt === null || this.now() < this.retryAt) return;
    if (o.isStoppedByUser() || !o.autoRecoverEnabled()) return;
    if (!o.isOnline()) {
      this.retryAt = this.now() + 60_000;
      return;
    }
    this.rearm();
    this.emit({ kind: 'retry', text: 'Повторная попытка восстановить обход' });

    const state = await o.verifyRunning();
    if (state.running) {
      const root = await o.resolveZapretPath();
      const strategy = root ? await o.resolveStrategy(root) : null;
      if (root && strategy && (await o.probe(root, strategy)) === 'ok') {
        this.setHealth('ok');
        o.onOutput('Сайты снова открываются — обход работает', 'success');
        this.emit({ kind: 'restored', text: 'Сайты снова открываются', strategy });
        o.onRecovered();
        return;
      }
    }
    await this.recover('Повторная попытка');
  }

  /** Снова следим за обходом, будто его только что включили */
  private rearm(): void {
    this.expectedRunning = true;
    this.retryAt = null;
    this.recoveryAttempts = 0;
    this.recoveryWindowStart = this.now();
    this.sameStrategyFailures = 0;
    this.healthFailStreak = 0;
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
      // в игре перебор конфигов и подбор откладываем: это десятки перезапусков winws подряд
      const canSwitch = o.autoSwitchEnabled() && !this.inGame();
      if (this.sameStrategyFailures < restartsBeforeSwitch || !canSwitch) {
        this.sameStrategyFailures += 1;
        const result = await this.tryStrategy(root, strategy);
        this.lastRecoveryAt = this.now();
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
        if (result === 'offline') this.refundAttempt();
        if (result === 'aborted' || result === 'offline') return;
        o.onOutput(`Перезапуск не помог. ${this.probeFailure()}`, 'warn');
        if (!canSwitch && this.inGame()) {
          o.onOutput('Идёт игра — другой конфиг подберу, когда она закроется', 'info');
          return;
        }
        // Последний перезапуск не помог — сразу ищем замену, не дожидаясь следующей проверки
        if (this.sameStrategyFailures < restartsBeforeSwitch || !canSwitch) return;
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
      if (result === 'offline') this.refundAttempt();
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

  private inGame(): boolean {
    return this.options.isGameMode?.() ?? false;
  }

  /** Игра закрылась — проверим сайты почти сразу, отложенный перебор начнётся с этого */
  gameEnded(delayMs = 10_000): void {
    const healthInterval = this.options.healthCheckIntervalMs ?? 30_000;
    this.lastHealthCheckAt = Math.min(this.lastHealthCheckAt, this.now() - healthInterval + delayMs);
  }

  /** Попытка сорвалась из-за сети, а не из-за конфига — не засчитываем её */
  private refundAttempt(): void {
    this.recoveryAttempts = Math.max(0, this.recoveryAttempts - 1);
    this.sameStrategyFailures = Math.max(0, this.sameStrategyFailures - 1);
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
    const delays = o.giveUpRetryMs ?? [5 * 60_000, 15 * 60_000, 30 * 60_000, 60 * 60_000];
    const delay = delays.length > 0 ? delays[Math.min(this.giveUpCount, delays.length - 1)] : null;
    this.giveUpCount += 1;
    this.expectedRunning = false;
    this.retryAt = delay === null ? null : this.now() + delay;
    this.setHealth('down');
    this.emit({ kind: 'gave-up', text: message });
    o.onGiveUp(this.retryAt);
    const retryNote = delay === null ? '' : `. Попробую снова через ${Math.round(delay / 60_000)} мин`;
    o.onOutput(message + retryNote, 'warn');
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
