import type { BypassEvent } from './bypass-events';
import type { StrategyRanking } from './tests-runner';

export interface LogLine {
  at: number;
  level: string;
  text: string;
}

export interface DiagnosticReportInput {
  generatedAt: number;
  appVersion: string;
  platform: string;
  isAdmin: boolean;
  /** только безобидные поля конфига — секреты прокси и ключи VPN сюда не попадают */
  settings: Record<string, unknown>;
  zapret: { path: string | null; running: boolean; strategy: string | null; strategies: number };
  watchdogHealth: string;
  network: string;
  rankings: StrategyRanking[];
  rankedAt: number | null;
  events: BypassEvent[];
  log: LogLine[];
  /** что вычистить из текста: домашняя папка, имя пользователя */
  redact: string[];
}

const MAX_LOG_LINES = 400;

export function redactText(text: string, secrets: string[]): string {
  let out = text;
  for (const secret of secrets.filter((s) => s.length >= 3).sort((a, b) => b.length - a.length)) {
    out = out.split(secret).join('<скрыто>');
  }
  return out;
}

export function buildDiagnosticReport(input: DiagnosticReportInput): string {
  const time = (ms: number) => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
  const pct = (r: StrategyRanking) => (r.maxScore > 0 ? Math.round((r.score / r.maxScore) * 100) : 0);
  const lines: string[] = [];

  lines.push('Skvoz — отчёт для разработчика');
  lines.push(`Создан: ${time(input.generatedAt)}`);
  lines.push(`Версия: ${input.appVersion} · ${input.platform} · администратор: ${input.isAdmin ? 'да' : 'нет'}`);
  lines.push('');

  lines.push('== Zapret ==');
  lines.push(`Папка: ${input.zapret.path ?? 'не найдена'}`);
  lines.push(`Обход: ${input.zapret.running ? 'работает' : 'выключен'} · конфиг: ${input.zapret.strategy ?? '—'}`);
  lines.push(`Конфигов: ${input.zapret.strategies} · состояние сторожа: ${input.watchdogHealth}`);
  lines.push(`Сеть: ${input.network}`);
  lines.push('');

  lines.push('== Настройки ==');
  for (const [key, value] of Object.entries(input.settings)) {
    lines.push(`${key}: ${JSON.stringify(value)}`);
  }
  lines.push('');

  lines.push(`== Рейтинг конфигов${input.rankedAt ? ` (${time(input.rankedAt)})` : ''} ==`);
  if (input.rankings.length === 0) lines.push('нет данных');
  for (const r of input.rankings) {
    const failed = r.failed.length > 0 ? ` · не открылось: ${r.failed.join(', ')}` : '';
    lines.push(`${pct(r)}% ${r.strategy} (${r.okChecks}/${r.totalChecks})${failed}`);
  }
  lines.push('');

  lines.push('== События ==');
  if (input.events.length === 0) lines.push('нет');
  for (const e of input.events) {
    lines.push(`${time(e.at)} [${e.kind}] ${e.text}${e.strategy ? ` · ${e.strategy}` : ''}`);
  }
  lines.push('');

  lines.push('== Журнал ==');
  const log = input.log.slice(-MAX_LOG_LINES);
  if (log.length === 0) lines.push('пусто');
  for (const line of log) {
    lines.push(`${time(line.at)} ${line.level.padEnd(7)} ${line.text}`);
  }

  return redactText(lines.join('\r\n'), input.redact) + '\r\n';
}
