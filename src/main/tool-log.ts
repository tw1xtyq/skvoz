import fs from 'fs';
import path from 'path';
import type { LogLine } from './diagnostic-report';

const MAX_SAVED_LINES = 50;

function isProblem(line: LogLine): boolean {
  return line.level === 'error' || line.level === 'warn';
}

/** Сбои сохраняем на диск: отчёт часто снимают уже после перезапуска, когда журнал в памяти пуст */
export function saveLogProblems(filePath: string, log: LogLine[]): void {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(log.filter(isProblem).slice(-MAX_SAVED_LINES)), 'utf8');
  } catch {
    /* журнал — только для диагностики */
  }
}

export function loadLogProblems(filePath: string): LogLine[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return Array.isArray(parsed) ? (parsed as LogLine[]).slice(-MAX_SAVED_LINES) : [];
  } catch {
    return [];
  }
}
