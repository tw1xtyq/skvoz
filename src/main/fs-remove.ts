import { spawn } from 'child_process';
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import { runHidden } from './exec';

function psQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function runPowerShell(script: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { windowsHide: true }
    );
    let stderr = '';
    child.stdout.on('data', () => {});
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(stderr.trim() || `PowerShell exited with code ${code}`));
    });
    child.on('error', reject);
  });
}

export async function killWinwsProcesses(): Promise<void> {
  for (let i = 0; i < 2; i += 1) {
    await runHidden('taskkill', ['/IM', 'winws.exe', '/F'], {
      timeoutMs: 15_000,
      onLine: () => {},
    }).catch(() => undefined);
    await delay(i === 0 ? 1200 : 600);
  }
}

export async function removeDirectoryRobust(dir: string): Promise<void> {
  if (!fs.existsSync(dir)) return;

  await killWinwsProcesses();
  await delay(500);

  let lastError: Error | null = null;

  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      await fsp.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 400 });
      if (!fs.existsSync(dir)) return;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      await killWinwsProcesses();
      await delay(800 * (attempt + 1));
      await yieldToEventLoop();
    }
  }

  const script = `
$ErrorActionPreference = 'Stop'
$path = ${psQuote(dir)}
if (-not (Test-Path -LiteralPath $path)) { exit 0 }
Get-ChildItem -LiteralPath $path -Force | ForEach-Object {
  if ($_.PSIsContainer) {
    Remove-Item -LiteralPath $_.FullName -Recurse -Force -ErrorAction SilentlyContinue
  } else {
    Remove-Item -LiteralPath $_.FullName -Force -ErrorAction SilentlyContinue
  }
}
Remove-Item -LiteralPath $path -Recurse -Force
`.trim();

  try {
    await runPowerShell(script);
  } catch (err) {
    const psError = err instanceof Error ? err.message : String(err);
    if (!fs.existsSync(dir)) return;
    throw new Error(
      lastError?.message
        ? `${lastError.message}${psError ? ` (${psError})` : ''}`
        : psError || `Не удалось удалить ${dir}`
    );
  }

  if (fs.existsSync(dir)) {
    throw lastError ?? new Error(`Не удалось удалить ${dir}`);
  }
}
