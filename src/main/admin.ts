import { execFileSync, execSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { app } from 'electron';

export const ELEVATED_RELAUNCH_ARG = '--zapret-elevated';

export function isElevatedRelaunch(): boolean {
  return process.argv.includes(ELEVATED_RELAUNCH_ARG);
}

/** Метка уровня токена: High или System значит, что процесс запущен с повышенными правами */
export function hasElevatedIntegrity(whoamiGroups: string): boolean {
  return /S-1-16-(12288|16384)\b/.test(whoamiGroups);
}

function detectWindowsAdmin(): boolean {
  try {
    const whoami = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'whoami.exe');
    const groups = execFileSync(whoami, ['/groups', '/fo', 'csv', '/nh'], {
      encoding: 'latin1',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5_000,
      windowsHide: true,
    });
    if (/S-1-16-\d+/.test(groups)) return hasElevatedIntegrity(groups);
  } catch {
    /* проверим запасным способом */
  }

  // net session зависит от службы «Сервер»: если её отключили, он отказывает и администратору
  try {
    execSync('net session', { stdio: 'ignore', windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

let windowsAdmin: boolean | null = null;

/** Права процесса не меняются, пока он работает, а проверка блокирует главный поток */
export function isWindowsAdmin(): boolean {
  if (process.platform !== 'win32') return true;
  windowsAdmin ??= detectWindowsAdmin();
  return windowsAdmin;
}

export function assertAdmin(): void {
  if (!isWindowsAdmin()) {
    throw new Error(
      'Нужны права администратора. Запустите приложение от имени администратора или нажмите «Перезапуск от администратора».'
    );
  }
}

function adminLauncherPath(): string {
  return process.execPath;
}

function adminWorkingDir(): string {
  return app.isPackaged ? path.dirname(process.execPath) : app.getAppPath();
}

function elevatedLaunchArgs(): string[] {
  const args: string[] = [];

  if (!app.isPackaged) {
    args.push(app.getAppPath());
  } else {
    for (const arg of process.argv.slice(1)) {
      if (arg === ELEVATED_RELAUNCH_ARG) continue;
      args.push(arg);
    }
  }

  args.push(ELEVATED_RELAUNCH_ARG);
  return args;
}

function windowsArgString(args: string[]): string {
  return args
    .map((arg) => {
      if (arg === '') return '""';
      if (!/[\s"]/u.test(arg)) return arg;
      return `"${arg.replace(/"/g, '\\"')}"`;
    })
    .join(' ');
}

function psSingleQuote(value: string): string {
  return value.replace(/'/g, "''");
}

function buildElevatedProcessScript(launcher: string, workingDir: string, args: string[]): string {
  const fileName = psSingleQuote(launcher);
  const workDir = psSingleQuote(workingDir);
  const argLine = psSingleQuote(windowsArgString(args));

  return [
    '$ErrorActionPreference = "Stop"',
    'try {',
    '  $psi = New-Object System.Diagnostics.ProcessStartInfo',
    `  $psi.FileName = '${fileName}'`,
    `  $psi.WorkingDirectory = '${workDir}'`,
    `  $psi.Arguments = '${argLine}'`,
    '  $psi.Verb = "runas"',
    '  $psi.UseShellExecute = $true',
    '  [void][System.Diagnostics.Process]::Start($psi)',
    '  exit 0',
    '} catch {',
    '  exit 1',
    '}',
  ].join('\n');
}

function runEncodedPowerShell(script: string): boolean {
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  try {
    execSync(`powershell.exe -NoProfile -ExecutionPolicy Bypass -EncodedCommand ${encoded}`, {
      stdio: 'ignore',
      timeout: 120_000,
      windowsHide: true,
    });
    return true;
  } catch {
    return false;
  }
}

function vbsQuote(value: string): string {
  return value.replace(/"/g, '""');
}

function launchViaVbs(launcher: string, workingDir: string, args: string[]): boolean {
  const argString = windowsArgString(args);
  const vbs = [
    'Set shell = CreateObject("Shell.Application")',
    `shell.ShellExecute "${vbsQuote(launcher)}", "${vbsQuote(argString)}", "${vbsQuote(workingDir)}", "runas", 1`,
  ].join('\r\n');

  const vbsPath = path.join(os.tmpdir(), `zapret-elevate-${process.pid}.vbs`);

  try {
    fs.writeFileSync(vbsPath, `\uFEFF${vbs}`, 'utf8');
    execSync(`wscript.exe //B //Nologo "${vbsPath}"`, {
      stdio: 'ignore',
      timeout: 30_000,
      windowsHide: true,
    });
    return true;
  } catch {
    return false;
  } finally {
    try {
      fs.unlinkSync(vbsPath);
    } catch {
      /* ignore */
    }
  }
}

function launchElevatedProcess(): boolean {
  const launcher = adminLauncherPath();
  const workingDir = adminWorkingDir();
  const args = elevatedLaunchArgs();
  const script = buildElevatedProcessScript(launcher, workingDir, args);

  if (runEncodedPowerShell(script)) {
    return true;
  }

  return launchViaVbs(launcher, workingDir, args);
}

/** Запускает UAC и завершает текущий процесс, если прав администратора нет. */
export function elevateIfNeeded(): boolean {
  if (process.platform !== 'win32' || isWindowsAdmin() || isElevatedRelaunch()) {
    return false;
  }

  return launchElevatedProcess();
}

export function restartAsAdmin(releaseSingleInstance?: () => void): boolean {
  if (isWindowsAdmin()) return true;

  const started = launchElevatedProcess();
  if (!started) return false;

  releaseSingleInstance?.();

  setTimeout(() => {
    app.quit();
  }, 400);

  return true;
}
