import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { isWindowsAdmin } from './admin';
import { decodeProcessOutput } from './exec';

export type OutputLevel = 'info' | 'success' | 'warn' | 'error';

export interface OutputLine {
  text: string;
  level: OutputLevel;
}

export type OutputCallback = (line: OutputLine) => void;

function runCmd(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, shell: false });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += decodeProcessOutput(d)));
    child.stderr.on('data', (d: Buffer) => (stderr += decodeProcessOutput(d)));
    child.on('close', (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(stderr.trim() || stdout.trim() || `Command failed: ${command}`));
    });
    child.on('error', reject);
  });
}

function emit(out: OutputCallback, text: string, level: OutputLevel = 'info'): void {
  out({ text, level });
}

async function serviceRunning(name: string): Promise<boolean> {
  try {
    const output = await runCmd('sc', ['query', name]);
    // sc локализован (STATE / Состояние) — ориентируемся на код 4 RUNNING.
    return /:\s*4\s+RUNNING\b/i.test(output);
  } catch {
    return false;
  }
}

export type ServiceState = 'missing' | 'stopped' | 'stopping' | 'running' | 'unknown';

/** Код состояния из `sc query` (вывод локализован, но «: 4 RUNNING» везде одинаковый) */
export function parseScState(output: string): ServiceState {
  if (/\b1060\b/.test(output)) return 'missing';
  // строка TYPE (": 1 KERNEL_DRIVER") идёт раньше STATE — ищем именно названия состояний
  const code = output.match(/:\s*(\d)\s+(?:STOPPED|START_PENDING|STOP_PENDING|RUNNING|CONTINUE_PENDING|PAUSE_PENDING|PAUSED)\b/)?.[1];
  if (code === '1') return 'stopped';
  if (code === '3') return 'stopping';
  if (code === '4' || code === '2') return 'running';
  return 'unknown';
}

/** Имена процессов из `tasklist /m WinDivert.dll /fo csv /nh`; при «нет задач» — пусто */
export function parseModuleHolders(output: string): string[] {
  const names = new Set<string>();
  for (const line of output.split(/\r?\n/)) {
    const name = line.match(/^"([^"]+)","\d+"/)?.[1];
    if (name) names.add(name);
  }
  return [...names];
}

async function serviceState(name: string): Promise<ServiceState> {
  try {
    return parseScState(await runCmd('sc', ['query', name]));
  } catch (err) {
    return parseScState(err instanceof Error ? err.message : String(err));
  }
}

async function windivertHolders(): Promise<string[]> {
  try {
    return parseModuleHolders(await runCmd('tasklist', ['/m', 'WinDivert.dll', '/fo', 'csv', '/nh']));
  } catch {
    return [];
  }
}

/**
 * WinDivert остался загружен без winws — обычно после аварийного выхода. Сам драйвер
 * помечает свою службу на удаление при загрузке, поэтому `sc delete` отвечает 1072
 * или 1060 — это не ошибка; судим по итоговому состоянию службы.
 */
async function removeStaleWinDivert(out: OutputCallback): Promise<void> {
  if (!isWindowsAdmin()) {
    emit(out, '[?] WinDivert активен без winws.exe — удалить можно только от администратора', 'warn');
    return;
  }

  const holders = await windivertHolders();
  if (holders.length > 0) {
    emit(out, `[X] WinDivert занят другой программой: ${holders.join(', ')}. Закройте её и повторите`, 'error');
    return;
  }

  emit(out, '[?] WinDivert активен без winws.exe — удаляю...', 'warn');
  await runCmd('sc', ['stop', 'WinDivert']).catch(() => undefined);
  await runCmd('sc', ['delete', 'WinDivert']).catch(() => undefined);

  // драйвер выгружается не мгновенно
  let state = await serviceState('WinDivert');
  for (let i = 0; i < 10 && (state === 'running' || state === 'stopping'); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    state = await serviceState('WinDivert');
  }

  if (state === 'missing') {
    emit(out, '[OK] WinDivert удалён', 'success');
  } else if (state === 'stopped') {
    emit(out, '[OK] WinDivert остановлен, служба исчезнет после перезагрузки — обходу это не мешает', 'success');
  } else {
    emit(out, '[X] WinDivert не останавливается — перезагрузите компьютер', 'error');
  }
}

async function serviceExists(name: string): Promise<boolean> {
  try {
    await runCmd('sc', ['query', name]);
    return true;
  } catch {
    return false;
  }
}

async function processRunning(name: string): Promise<boolean> {
  try {
    const output = await runCmd('tasklist', ['/FI', `IMAGENAME eq ${name}`, '/FO', 'CSV', '/NH']);
    return output.toLowerCase().includes(name.toLowerCase());
  } catch {
    return false;
  }
}

async function scQueryContains(filter: string): Promise<boolean> {
  try {
    const output = await runCmd('sc', ['query', 'state=', 'all']);
    return output.toLowerCase().includes(filter.toLowerCase());
  } catch {
    return false;
  }
}

export function isTcpTimestampsEnabled(netshOutput: string): boolean {
  for (const line of netshOutput.split(/\r?\n/)) {
    if (!/(timestamps|rfc\s*1323|метки\s+времени)/i.test(line)) continue;
    if (/:\s*enabled\b/i.test(line)) return true;
    if (/:\s*disabled\b/i.test(line)) return false;
  }
  return /(timestamps|rfc\s*1323|метки\s+времени)[^\n]*:\s*enabled/i.test(netshOutput);
}

async function ensureBfeRunning(out: OutputCallback): Promise<void> {
  if (await serviceRunning('BFE')) {
    emit(out, '[OK] Base Filtering Engine работает', 'success');
    return;
  }

  if (isWindowsAdmin()) {
    emit(out, '[?] Base Filtering Engine остановлен — пробую запустить...', 'warn');
    try {
      await runCmd('net', ['start', 'BFE']);
      if (await serviceRunning('BFE')) {
        emit(out, '[OK] Base Filtering Engine запущен', 'success');
        return;
      }
    } catch {
      /* fall through */
    }
  }

  emit(
    out,
    isWindowsAdmin()
      ? '[X] Base Filtering Engine не запущен. Откройте services.msc → «Служба базовой фильтрации» → Запустить'
      : '[X] Base Filtering Engine не запущен. Запустите приложение от администратора или выполните: net start BFE',
    'error'
  );
}

export async function runDiagnosticsInApp(root: string, out: OutputCallback): Promise<void> {
  emit(out, '=== Диагностика zapret ===', 'info');

  await ensureBfeRunning(out);

  try {
    const proxyEnable = await runCmd('reg', [
      'query',
      'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings',
      '/v',
      'ProxyEnable',
    ]);
    const enabled = /0x1/.test(proxyEnable);
    if (enabled) {
      let proxyServer = '';
      try {
        const serverOut = await runCmd('reg', [
          'query',
          'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings',
          '/v',
          'ProxyServer',
        ]);
        const match = serverOut.match(/ProxyServer\s+REG_SZ\s+(.+)/i);
        proxyServer = match?.[1]?.trim() ?? '';
      } catch {
        /* ignore */
      }
      emit(out, `[?] Включён системный прокси: ${proxyServer || 'неизвестно'}`, 'warn');
    } else {
      emit(out, '[OK] Системный прокси выключен', 'success');
    }
  } catch {
    emit(out, '[OK] Системный прокси выключен', 'success');
  }

  try {
    const tcpGlobal = await runCmd('netsh', ['interface', 'tcp', 'show', 'global']);
    if (isTcpTimestampsEnabled(tcpGlobal)) {
      emit(out, '[OK] TCP timestamps включены', 'success');
    } else {
      emit(out, '[?] TCP timestamps выключены, включаю...', 'warn');
      await runCmd('netsh', ['interface', 'tcp', 'set', 'global', 'timestamps=enabled']);
      emit(out, '[OK] TCP timestamps включены', 'success');
    }
  } catch {
    emit(out, '[?] Не удалось проверить TCP timestamps', 'warn');
  }

  if (await processRunning('AdguardSvc.exe')) {
    emit(out, '[X] Найден Adguard — может мешать Discord', 'error');
  } else {
    emit(out, '[OK] Adguard не найден', 'success');
  }

  if (await scQueryContains('Killer')) {
    emit(out, '[X] Найден Killer — конфликтует с zapret', 'error');
  } else {
    emit(out, '[OK] Killer не найден', 'success');
  }

  if (await scQueryContains('SmartByte')) {
    emit(out, '[X] Найден SmartByte — конфликтует с zapret', 'error');
  } else {
    emit(out, '[OK] SmartByte не найден', 'success');
  }

  const binDir = path.join(root, 'bin');
  const hasSys = fs.existsSync(binDir) && fs.readdirSync(binDir).some((f) => f.endsWith('.sys'));
  if (hasSys) {
    emit(out, '[OK] WinDivert .sys найден', 'success');
  } else {
    emit(out, '[X] WinDivert64.sys не найден в bin', 'error');
  }

  const winwsRunning = await processRunning('winws.exe');
  const windivertRunning = await serviceRunning('WinDivert');
  if (!winwsRunning && windivertRunning) {
    await removeStaleWinDivert(out);
  }

  const conflicts = ['GoodbyeDPI', 'discordfix_zapret', 'winws1', 'winws2'];
  const found = [];
  for (const name of conflicts) {
    if (await serviceExists(name)) found.push(name);
  }
  if (found.length) {
    emit(out, `[X] Конфликтующие службы: ${found.join(', ')}`, 'error');
  } else {
    emit(out, '[OK] Конфликтующие bypass-службы не найдены', 'success');
  }

  const hostsFile = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'drivers', 'etc', 'hosts');
  if (fs.existsSync(hostsFile)) {
    const hosts = fs.readFileSync(hostsFile, 'utf8').toLowerCase();
    if (hosts.includes('youtube.com') || hosts.includes('youtu.be')) {
      emit(out, '[?] В hosts есть записи YouTube — может мешать доступу', 'warn');
    }
  }

  emit(out, '=== Диагностика завершена ===', 'info');
}
