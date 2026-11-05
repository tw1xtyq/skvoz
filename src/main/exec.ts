import { spawn, type SpawnOptions } from 'child_process';
import fs from 'fs';
import type { OutputCallback } from './diagnostics';

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, '');
}

function countCyrillic(text: string): number {
  return (text.match(/[А-Яа-яЁё]/g) ?? []).length;
}

function looksLikeMojibake(text: string): boolean {
  return text.includes('\uFFFD') || /╨/.test(text) || /[\u2500-\u257F]{2,}/.test(text);
}

export function decodeProcessOutput(data: Buffer): string {
  if (process.platform !== 'win32') return data.toString('utf8');
  if (data.length === 0) return '';

  const utf8 = data.toString('utf8');
  const utf8Cyr = countCyrillic(utf8);

  if (!looksLikeMojibake(utf8) && (utf8Cyr > 0 || /^[\x09\x0A\x0D\x20-\x7E]*$/.test(utf8))) {
    return utf8;
  }

  try {
    const cp866 = new TextDecoder('cp866').decode(data);
    const cp866Cyr = countCyrillic(cp866);
    if (cp866Cyr > utf8Cyr) return cp866;
  } catch {
    /* fall through */
  }

  return utf8;
}

function emitChunk(
  chunk: Buffer,
  level: 'info' | 'error',
  onLine?: OutputCallback
): void {
  if (!onLine) return;
  const text = stripAnsi(decodeProcessOutput(chunk));
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trimEnd();
    if (trimmed) onLine({ text: trimmed, level });
  }
}

export function runHidden(
  command: string,
  args: string[],
  options: { cwd?: string; input?: string; onLine?: OutputCallback; timeoutMs?: number } = {}
): Promise<number> {
  return new Promise((resolve, reject) => {
    const spawnOpts: SpawnOptions = {
      cwd: options.cwd,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
    };

    const child = spawn(command, args, spawnOpts);
    let stderr = '';
    let settled = false;

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      fn();
    };

    const timer =
      options.timeoutMs && options.timeoutMs > 0
        ? setTimeout(() => {
            child.kill();
            finish(() => reject(new Error(`Таймаут: ${command} (${options.timeoutMs}ms)`)));
          }, options.timeoutMs)
        : null;

    const emitLines = (chunk: Buffer, level: 'info' | 'error' = 'info') => {
      emitChunk(chunk, level, options.onLine);
    };

    child.stdout?.on('data', (d: Buffer) => emitLines(d, 'info'));
    child.stderr?.on('data', (d: Buffer) => {
      stderr += decodeProcessOutput(d);
      emitLines(d, 'error');
    });

    if (options.input && child.stdin) {
      child.stdin.write(options.input);
    }
    child.stdin?.end();

    child.on('error', (err) => finish(() => reject(err)));
    child.on('close', (code) => {
      finish(() => {
        if (code && code !== 0 && !options.onLine) {
          reject(new Error(stderr.trim() || `${command} exited with code ${code}`));
          return;
        }
        resolve(code ?? 0);
      });
    });
  });
}

/** Запускает процесс отдельно от приложения; вывод идёт в logPath, чтобы было видно причину сбоя. */
export function runDetachedHidden(
  command: string,
  args: string[],
  cwd: string | undefined,
  logPath: string
): Promise<{ exited: Promise<number | null> }> {
  return new Promise((resolve, reject) => {
    let log: number | 'ignore' = 'ignore';
    try {
      log = fs.openSync(logPath, 'w');
    } catch {
      /* запуск важнее журнала */
    }
    const closeLog = (): void => {
      if (log !== 'ignore') fs.closeSync(log);
      log = 'ignore';
    };

    const child = spawn(command, args, {
      cwd,
      windowsHide: true,
      detached: true,
      stdio: ['ignore', log, log],
      shell: false,
    });
    const exited = new Promise<number | null>((done) => child.once('exit', (code) => done(code)));

    child.once('error', (err: NodeJS.ErrnoException) => {
      closeLog();
      if (err.code === 'EACCES') {
        reject(
          new Error(
            'Доступ к winws.exe запрещён. Запустите приложение от имени администратора.'
          )
        );
        return;
      }
      reject(err);
    });

    child.once('spawn', () => {
      closeLog();
      child.unref();
      resolve({ exited });
    });
  });
}

export async function runBatHidden(batPath: string, cwd: string, onLine?: OutputCallback): Promise<void> {
  await runHidden('cmd.exe', ['/c', batPath], { cwd, onLine });
}

export async function pipeToServiceBat(
  root: string,
  choices: string[],
  onLine?: OutputCallback
): Promise<void> {
  const input = `${choices.map((c) => `${c}\r\n`).join('')}\r\n`;
  await runHidden('cmd.exe', ['/c', 'service.bat', 'admin'], { cwd: root, input, onLine });
}
