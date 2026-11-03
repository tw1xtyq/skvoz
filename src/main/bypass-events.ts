import fs from 'fs';
import path from 'path';

export type BypassEventKind =
  | 'started'
  | 'stopped'
  | 'crashed'
  | 'blocked'
  | 'restored'
  | 'switched'
  | 'gave-up'
  | 'network'
  | 'rerank'
  | 'update';

export interface BypassEvent {
  at: number;
  kind: BypassEventKind;
  text: string;
  strategy?: string | null;
}

const MAX_EVENTS = 100;
// Подряд одинаковые события (winws падает каждые 8 с) склеиваем, чтобы не забить ленту
const MERGE_WINDOW_MS = 2 * 60_000;

/** Короткая лента «что происходило с обходом»: переживает перезапуск приложения. */
export class BypassEventLog {
  private events: BypassEvent[];

  constructor(
    private readonly filePath: string | null,
    private readonly now: () => number = () => Date.now()
  ) {
    this.events = this.load();
  }

  add(kind: BypassEventKind, text: string, strategy?: string | null): BypassEvent {
    const at = this.now();
    const last = this.events[this.events.length - 1];
    if (last && last.kind === kind && last.text === text && at - last.at < MERGE_WINDOW_MS) {
      last.at = at;
      this.persist();
      return last;
    }
    const event: BypassEvent = { at, kind, text, strategy: strategy ?? null };
    this.events.push(event);
    if (this.events.length > MAX_EVENTS) this.events.splice(0, this.events.length - MAX_EVENTS);
    this.persist();
    return event;
  }

  /** Новые сверху */
  list(limit = MAX_EVENTS): BypassEvent[] {
    return this.events.slice(-limit).reverse();
  }

  /** С какого момента и на каком конфиге обход работает без остановок */
  runningSince(): { at: number; strategy: string | null } | null {
    for (let i = this.events.length - 1; i >= 0; i -= 1) {
      const event = this.events[i];
      if (event.kind === 'stopped' || event.kind === 'gave-up') return null;
      if (event.kind === 'started' || event.kind === 'switched') {
        return { at: event.at, strategy: event.strategy ?? null };
      }
    }
    return null;
  }

  private load(): BypassEvent[] {
    if (!this.filePath) return [];
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      return Array.isArray(parsed) ? (parsed as BypassEvent[]).slice(-MAX_EVENTS) : [];
    } catch {
      return [];
    }
  }

  private persist(): void {
    if (!this.filePath) return;
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.writeFileSync(this.filePath, JSON.stringify(this.events), 'utf8');
    } catch {
      /* лента — только для удобства */
    }
  }
}
