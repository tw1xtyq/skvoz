import fs from 'fs';
import path from 'path';
import { assertAdmin } from './admin';
import type { OutputCallback } from './diagnostics';
import { unblockZapretInstall } from './downloader';
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

function extractWinwsLaunch(
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

async function prepareBypass(root: string, out?: OutputCallback): Promise<void> {
  out?.({ text: 'Подготовка окружения...', level: 'info' });

  await runHidden('netsh', ['interface', 'tcp', 'set', 'global', 'timestamps=enabled'], {
    onLine: (line) => out?.(line),
    timeoutMs: 20_000,
  });

  await runHidden('cmd.exe', ['/c', 'call service.bat load_game_filter && call service.bat load_user_lists'], {
    cwd: root,
    onLine: (line) => out?.(line),
    timeoutMs: 30_000,
  });
}

export async function startBypassHidden(root: string, strategyFile: string, out?: OutputCallback): Promise<void> {
  assertAdmin();
  const batPath = path.join(root, strategyFile);
  if (!fs.existsSync(batPath)) {
    throw new Error(`Стратегия не найдена: ${strategyFile}`);
  }

  out?.({ text: `Подготовка ${strategyFile}...`, level: 'info' });
  await unblockZapretInstall(root);
  await prepareBypass(root, out);

  const launch = extractWinwsLaunch(root, strategyFile);
  if (!fs.existsSync(launch.exe)) {
    throw new Error(`winws.exe не найден: ${launch.exe}`);
  }

  out?.({ text: `Запуск winws.exe (${strategyFile})...`, level: 'info' });
  await runDetachedHidden(launch.exe, launch.args, path.dirname(launch.exe));
  out?.({ text: '[OK] Обход запущен', level: 'success' });
}
