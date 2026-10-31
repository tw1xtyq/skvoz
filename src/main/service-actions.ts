import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { assertAdmin } from './admin';
import type { OutputCallback } from './diagnostics';
import {
  assertWinwsRunningAfterLaunch,
  ensureRequiredLists,
  ensureStrategyBins,
  ensureWinwsStopped,
  validateStrategyAssets,
} from './bypass-prep';
import { unblockZapretInstall } from './downloader';
import { ensureUserListFiles } from './user-lists';
import { runDetachedHidden, runHidden } from './exec';

function readGameFilterPorts(root: string): { tcp: string; udp: string } {
  const flagFile = path.join(root, 'utils', 'game_filter.enabled');
  const disabled = { tcp: '12', udp: '12' };

  if (!fs.existsSync(flagFile)) return disabled;

  const mode = fs.readFileSync(flagFile, 'utf8').trim().toLowerCase();
  if (mode === 'all') return { tcp: '1024-65535', udp: '1024-65535' };
  if (mode === 'tcp') return { tcp: '1024-65535', udp: '12' };
  if (mode === 'udp') return { tcp: '12', udp: '1024-65535' };
  return disabled;
}

function parseCommandLine(input: string): string[] {
  const args: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    // как в cmd: ^ вне кавычек экранирует следующий символ (--dpi-desync-fake-tls=^! → !)
    if (ch === '^' && !inQuotes && i + 1 < input.length) {
      current += input[i + 1];
      i += 1;
      continue;
    }
    if (ch === '"') {
      inQuotes = !inQuotes;
      continue;
    }
    if (!inQuotes && /\s/.test(ch)) {
      if (current) {
        args.push(current);
        current = '';
      }
      continue;
    }
    current += ch;
  }

  if (current) args.push(current);
  return args;
}

export function extractWinwsLaunch(
  root: string,
  strategyFile: string
): { exe: string; args: string[]; argString: string } {
  const batPath = path.join(root, strategyFile);
  let content = fs.readFileSync(batPath, 'utf8').replace(/\r/g, '');
  content = content.replace(/\^\s*\n/g, ' ');

  const bin = path.join(root, 'bin') + path.sep;
  const lists = path.join(root, 'lists') + path.sep;
  const { tcp, udp } = readGameFilterPorts(root);
  const rootSlash = root.endsWith(path.sep) ? root : `${root}${path.sep}`;

  content = content
    .replace(/%~dp0/gi, rootSlash)
    .replace(/%BIN%/gi, bin)
    .replace(/%LISTS%/gi, lists)
    .replace(/%GameFilterTCP%/gi, tcp)
    .replace(/%GameFilterUDP%/gi, udp);

  const match =
    content.match(/start\s+"[^"]*"\s+\/min\s+"([^"]*winws\.exe)"\s+([\s\S]*)/i) ??
    content.match(/"([^"]*winws\.exe)"\s+([\s\S]*)/i);

  if (!match) {
    throw new Error(`Не удалось разобрать команду winws.exe в ${strategyFile}`);
  }

  const exe = path.normalize(match[1].trim());
  const argString = match[2]
    .replace(/\s*::.*$/gm, '')
    .replace(/\s*echo.*$/gim, '')
    .trim();

  return { exe, args: parseCommandLine(argString), argString };
}

async function runCmdOutput(command: string, args: string[], timeoutMs = 8_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`Таймаут: ${command}`));
    }, timeoutMs);

    child.stdout?.on('data', (d: Buffer) => {
      stdout += d.toString();
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', () => {
      clearTimeout(timer);
      resolve(stdout);
    });
  });
}

async function ensureTcpTimestamps(out?: OutputCallback): Promise<void> {
  try {
    const status = await runCmdOutput('netsh', ['interface', 'tcp', 'show', 'global']);
    if (/timestamps\s*:\s*enabled/i.test(status)) return;
  } catch {
    /* try to enable below */
  }

  await runHidden('netsh', ['interface', 'tcp', 'set', 'global', 'timestamps=enabled'], {
    onLine: (line) => out?.(line),
    timeoutMs: 8_000,
  });
}

async function prepareBypass(root: string, out?: OutputCallback): Promise<void> {
  out?.({ text: 'Подготовка окружения...', level: 'info' });
  ensureUserListFiles(root);
  ensureRequiredLists(root);
  const restoredBins = ensureStrategyBins(root);
  if (restoredBins.length > 0) {
    out?.({ text: `Подготовлены bin: ${restoredBins.join(', ')}`, level: 'info' });
  }
  await ensureTcpTimestamps(out);
}

export async function startBypassHidden(root: string, strategyFile: string, out?: OutputCallback): Promise<void> {
  assertAdmin();
  const batPath = path.join(root, strategyFile);
  if (!fs.existsSync(batPath)) {
    throw new Error(`Стратегия не найдена: ${strategyFile}`);
  }

  out?.({ text: `Подготовка ${strategyFile}...`, level: 'info' });
  await Promise.all([unblockZapretInstall(root), prepareBypass(root, out)]);

  const launch = extractWinwsLaunch(root, strategyFile);
  if (!fs.existsSync(launch.exe)) {
    throw new Error(`winws.exe не найден: ${launch.exe}`);
  }
  validateStrategyAssets(launch.args);

  await ensureWinwsStopped();
  out?.({ text: `Запуск winws.exe (${strategyFile})...`, level: 'info' });
  await runDetachedHidden(launch.exe, launch.args, path.dirname(launch.exe));
  await assertWinwsRunningAfterLaunch();
  out?.({ text: '[OK] Обход запущен', level: 'success' });
}
