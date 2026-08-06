import fs from 'fs';
import path from 'path';
import { assertAdmin } from './admin';
import type { OutputCallback } from './diagnostics';
import { runHidden } from './exec';
import { killWinwsProcesses, removeDirectoryRobust } from './fs-remove';
import { scanForInstallations } from './scanner';

const ZAPRET_SERVICES = [
  'zapret',
  'WinDivert',
  'WinDivert14',
  'GoodbyeDPI',
  'discordfix_zapret',
  'winws1',
  'winws2',
];

function isZapretRoot(dir: string): boolean {
  return fs.existsSync(path.join(dir, 'bin', 'winws.exe'));
}

function shouldIgnoreCleanupLine(text: string): boolean {
  return /не удается найти|not found|1060|2185|1062|отсутствуют|does not exist/i.test(text);
}

export async function shutdownZapretCompletely(out: OutputCallback): Promise<void> {
  assertAdmin();
  out({ text: 'Полное отключение zapret...', level: 'info' });

  const serviceScript = ZAPRET_SERVICES.map((s) => `net stop ${s} 2>$null; sc delete ${s} 2>$null`).join('; ');
  const script = `
$ErrorActionPreference = 'SilentlyContinue'
taskkill /IM winws.exe /F 2>$null
${serviceScript}
Start-Sleep -Seconds 2
taskkill /IM winws.exe /F 2>$null
Start-Sleep -Seconds 1
Write-Output 'SHUTDOWN_DONE'
`.trim();

  await runHidden('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
    onLine: (line) => {
      if (line.text === 'SHUTDOWN_DONE') {
        out({ text: 'Обход и службы отключены', level: 'success' });
        return;
      }
      if (shouldIgnoreCleanupLine(line.text)) return;
      out(line);
    },
    timeoutMs: 90_000,
  });
}

export async function fullRemoveZapretFromPc(
  currentRoot: string | null,
  installBase: string,
  out: OutputCallback
): Promise<{ removedPaths: string[] }> {
  assertAdmin();
  await shutdownZapretCompletely(out);
  await killWinwsProcesses();

  const paths = new Set<string>();
  if (currentRoot && isZapretRoot(currentRoot)) {
    paths.add(path.resolve(currentRoot));
  }

  const hints = currentRoot ? [currentRoot] : [];
  const scan = await scanForInstallations(hints, installBase, { deep: false });
  for (const candidate of scan.candidates) {
    if (isZapretRoot(candidate.path)) {
      paths.add(path.resolve(candidate.path));
    }
  }

  const removedPaths: string[] = [];
  if (paths.size === 0) {
    out({ text: 'Папки zapret для удаления не найдены', level: 'info' });
    return { removedPaths };
  }

  out({ text: `Удаление ${paths.size} ${paths.size === 1 ? 'папки' : 'папок'} zapret...`, level: 'info' });

  for (const dir of paths) {
    try {
      await removeDirectoryRobust(dir);
      removedPaths.push(dir);
      out({ text: `Удалено: ${dir}`, level: 'success' });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      out({ text: `Не удалось удалить ${dir}: ${message}`, level: 'error' });
      throw new Error(
        `Не удалось удалить папку zapret. Остановите обход, закройте файлы из «${dir}» и повторите. ${message}`
      );
    }
  }

  if (removedPaths.length > 0) {
    out({ text: 'Zapret удалён с компьютера', level: 'success' });
  }

  return { removedPaths };
}
