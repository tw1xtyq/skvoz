import path from 'path';

/**
 * Приложение вызывает sc, reg, tasklist и powershell по имени. Если в PATH нет System32
 * (его обрезают установщики и чистильщики), ломается почти всё, поэтому дописываем сами.
 */
export function withSystemPath(current: string, systemRoot: string): string {
  const system32 = path.win32.join(systemRoot, 'System32');
  const required = [system32, path.win32.join(system32, 'WindowsPowerShell', 'v1.0')];
  const present = new Set(current.split(';').map((dir) => dir.trim().replace(/\\+$/, '').toLowerCase()));
  const missing = required.filter((dir) => !present.has(dir.toLowerCase()));
  return [current, ...missing].filter(Boolean).join(';');
}
