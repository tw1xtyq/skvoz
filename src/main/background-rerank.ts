export interface BackgroundRerankOptions {
  checkIntervalMs?: number;
  /** сколько секунд без мыши и клавиатуры считается простоем */
  idleThresholdSec?: number;
  /** после неудачной или прерванной попытки не пробуем снова столько времени */
  retryCooldownMs?: number;
  isEnabled: () => boolean;
  /** права администратора, нет подбора и автовосстановления, не от батареи */
  canRun: () => boolean;
  getIdleSeconds: () => number;
  /** идёт видео или игра: экран просят не гасить, хотя мышь никто не трогает */
  isUserWatching?: () => Promise<boolean>;
  needsRerank: () => Promise<boolean>;
  /** shouldCancel становится true, как только пользователь вернулся к компьютеру */
  run: (shouldCancel: () => boolean) => Promise<'done' | 'cancelled' | 'failed'>;
  now?: () => number;
}

/** Перепроверяет конфиги, пока компьютер простаивает: подбор на минуту-две выключает обход. */
export class BackgroundRerank {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private lastAttemptAt = Number.NEGATIVE_INFINITY;

  constructor(private readonly options: BackgroundRerankOptions) {}

  get isRunning(): boolean {
    return this.running;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.check(), this.options.checkIntervalMs ?? 5 * 60_000);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async check(): Promise<boolean> {
    const o = this.options;
    if (this.running || !o.isEnabled() || !o.canRun()) return false;
    const idleThreshold = o.idleThresholdSec ?? 10 * 60;
    if (o.getIdleSeconds() < idleThreshold) return false;
    if (this.now() - this.lastAttemptAt < (o.retryCooldownMs ?? 60 * 60_000)) return false;
    if (!(await o.needsRerank())) return false;
    if (o.isUserWatching && (await o.isUserWatching())) return false;

    this.running = true;
    try {
      const result = await o.run(() => o.getIdleSeconds() < 5);
      // удачный прогон обновит рейтинг, и needsRerank сам вернёт false — паузу держим только после сбоя
      if (result !== 'done') this.lastAttemptAt = this.now();
      return result === 'done';
    } catch {
      this.lastAttemptAt = this.now();
      return false;
    } finally {
      this.running = false;
    }
  }

  private now(): number {
    return this.options.now ? this.options.now() : Date.now();
  }
}

/**
 * Простой по мыши и клавиатуре — ещё не простой: фильм тоже смотрят не трогая мышь.
 * Плеер на это время просит Windows не гасить экран; такие запросы видны в
 * `powercfg /requests` в разделах DISPLAY и AWAYMODE. SYSTEM не смотрим: там
 * висит любой открытый аудиопоток, а Discord держит его всегда.
 */
export function hasDisplayRequests(powercfgOutput: string): boolean {
  let section = '';
  for (const raw of powercfgOutput.split(/\r?\n/)) {
    const line = raw.trim();
    const header = line.match(/^([A-Z]+):$/);
    if (header) {
      section = header[1];
      continue;
    }
    if ((section === 'DISPLAY' || section === 'AWAYMODE') && line.startsWith('[')) return true;
  }
  return false;
}
