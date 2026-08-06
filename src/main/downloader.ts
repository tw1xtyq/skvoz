import { spawn } from 'child_process';
import fs from 'fs';
import fsp from 'fs/promises';
import os from 'os';
import path from 'path';
import { removeDirectoryRobust } from './fs-remove';
import { ensureUserListFiles } from './user-lists';

export const GITHUB_REPO = 'Flowseal/zapret-discord-youtube';
export const GITHUB_RELEASES_URL = `https://github.com/${GITHUB_REPO}/releases/latest`;

export interface ReleaseInfo {
  version: string;
  zipUrl: string;
  zipName: string;
  releasePage: string;
}

export interface DownloadProgress {
  stage: 'fetch' | 'download' | 'extract' | 'install' | 'done' | 'error';
  percent: number;
  message: string;
}

export type ProgressCallback = (progress: DownloadProgress) => void;

const PROGRESS_MIN_INTERVAL_MS = 160;

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function createProgressReporter(onProgress: ProgressCallback): ProgressCallback {
  let lastAt = 0;
  let lastKey = '';

  return (progress) => {
    const force =
      progress.stage === 'done' ||
      progress.stage === 'error' ||
      progress.stage === 'fetch' ||
      progress.stage === 'extract' ||
      progress.stage === 'install';

    const key = `${progress.stage}:${progress.percent}:${progress.message}`;
    const now = Date.now();

    if (!force && key === lastKey && now - lastAt < PROGRESS_MIN_INTERVAL_MS) {
      return;
    }

    lastAt = now;
    lastKey = key;
    onProgress(progress);
  };
}

const USER_FILES = [
  'lists/list-general-user.txt',
  'lists/list-exclude-user.txt',
  'lists/ipset-exclude-user.txt',
  'utils/game_filter.enabled',
  'utils/check_updates.enabled',
];

function runPowerShell(script: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { windowsHide: true }
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('close', (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(stderr.trim() || `PowerShell exited with code ${code}`));
    });
    child.on('error', reject);
  });
}

function psQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export async function fetchLatestRelease(): Promise<ReleaseInfo> {
  const response = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/releases/latest`, {
    headers: { 'User-Agent': 'zapret-app', Accept: 'application/vnd.github+json' },
  });

  if (!response.ok) {
    throw new Error(`Не удалось получить релиз GitHub: HTTP ${response.status}`);
  }

  const data = (await response.json()) as {
    tag_name: string;
    html_url: string;
    assets: Array<{ name: string; browser_download_url: string }>;
  };

  const zipAsset =
    data.assets.find((asset) => asset.name.endsWith('.zip')) ??
    data.assets.find((asset) => /zapret-discord-youtube/i.test(asset.name));

  if (!zipAsset) {
    throw new Error('В последнем релизе не найден ZIP-архив');
  }

  return {
    version: data.tag_name.replace(/^v/, ''),
    zipUrl: zipAsset.browser_download_url,
    zipName: zipAsset.name,
    releasePage: data.html_url,
  };
}

async function downloadFile(
  url: string,
  dest: string,
  onProgress: ProgressCallback
): Promise<void> {
  const report = createProgressReporter(onProgress);
  const response = await fetch(url, {
    headers: { 'User-Agent': 'zapret-app' },
    redirect: 'follow',
  });

  if (!response.ok || !response.body) {
    throw new Error(`Ошибка загрузки: HTTP ${response.status}`);
  }

  const total = parseInt(response.headers.get('content-length') ?? '0', 10);
  const reader = response.body.getReader();
  const file = fs.createWriteStream(dest);
  let downloaded = 0;
  let lastPercent = -1;
  let lastReportAt = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    downloaded += value.length;

    if (!file.write(Buffer.from(value))) {
      await new Promise<void>((resolve) => file.once('drain', resolve));
    }

    const percent = total > 0 ? Math.min(99, Math.round((downloaded / total) * 100)) : 0;
    const now = Date.now();
    const shouldReport =
      total === 0
        ? now - lastReportAt >= 250
        : percent !== lastPercent || now - lastReportAt >= PROGRESS_MIN_INTERVAL_MS || percent >= 99;

    if (shouldReport) {
      report({
        stage: 'download',
        percent,
        message: total > 0 ? `Загрузка: ${percent}%` : `Загрузка: ${formatBytes(downloaded)}`,
      });
      lastPercent = percent;
      lastReportAt = now;
    }
  }

  await new Promise<void>((resolve, reject) => {
    file.end(() => resolve());
    file.on('error', reject);
  });
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function findZapretRoot(dir: string): string | null {
  if (fs.existsSync(path.join(dir, 'bin', 'winws.exe'))) {
    return dir;
  }

  if (!fs.existsSync(dir)) return null;

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const found = findZapretRoot(path.join(dir, entry.name));
    if (found) return found;
  }

  return null;
}

function backupUserFiles(sourceRoot: string): Map<string, Buffer> {
  const backup = new Map<string, Buffer>();
  for (const relativePath of USER_FILES) {
    const fullPath = path.join(sourceRoot, relativePath);
    if (fs.existsSync(fullPath)) {
      backup.set(relativePath, fs.readFileSync(fullPath));
    }
  }
  return backup;
}

function restoreUserFiles(targetRoot: string, backup: Map<string, Buffer>): void {
  for (const [relativePath, content] of backup) {
    const fullPath = path.join(targetRoot, relativePath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content);
  }
}

async function removeFileQuiet(filePath: string): Promise<void> {
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch {
    /* ignore */
  }
}

async function extractZip(zipPath: string, destDir: string, onProgress: ProgressCallback): Promise<void> {
  const report = createProgressReporter(onProgress);
  report({ stage: 'extract', percent: 0, message: 'Распаковка архива...' });
  await fsp.mkdir(destDir, { recursive: true });

  const script = `
$ErrorActionPreference = 'Stop'
Expand-Archive -LiteralPath ${psQuote(zipPath)} -DestinationPath ${psQuote(destDir)} -Force
`.trim();

  await runPowerShell(script);
  await removeFileQuiet(zipPath);
  report({ stage: 'extract', percent: 100, message: 'Архив распакован' });
}

async function unblockZapretBinaries(root: string): Promise<void> {
  const binDir = path.join(root, 'bin');
  if (!fs.existsSync(binDir)) return;

  const script = `
$ErrorActionPreference = 'SilentlyContinue'
Get-ChildItem -LiteralPath ${psQuote(binDir)} -Recurse -Include *.exe,*.dll -File | Unblock-File
`.trim();
  await runPowerShell(script);
}

export async function unblockZapretInstall(root: string): Promise<void> {
  if (!root || !fs.existsSync(root)) return;
  await unblockZapretBinaries(root);
}

async function removeDirectory(dir: string, aggressive = false): Promise<void> {
  if (!fs.existsSync(dir)) return;

  if (!aggressive) {
    try {
      await fsp.rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 150 });
      return;
    } catch {
      /* fall through to robust remove */
    }
  }

  await removeDirectoryRobust(dir);
}

async function copyDirectoryRobocopy(
  source: string,
  target: string,
  onPulse?: () => void
): Promise<void> {
  await fsp.mkdir(target, { recursive: true });

  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      'robocopy',
      [
        source,
        target,
        '/E',
        '/COPY:DAT',
        '/R:1',
        '/W:1',
        '/NFL',
        '/NDL',
        '/NJH',
        '/NJS',
        '/nc',
        '/ns',
        '/np',
      ],
      { windowsHide: true }
    );

    const pulse = onPulse ? setInterval(onPulse, 1800) : null;
    child.stdout.on('data', () => {});
    child.stderr.on('data', () => {});

    child.on('close', (code) => {
      if (pulse) clearInterval(pulse);
      if (code !== null && code >= 0 && code <= 7) {
        resolve();
        return;
      }
      reject(new Error(`robocopy завершился с кодом ${code ?? 'unknown'}`));
    });
    child.on('error', (err) => {
      if (pulse) clearInterval(pulse);
      reject(err);
    });
  });
}

async function copyDirectory(source: string, target: string, onPulse?: () => void): Promise<void> {
  await removeDirectory(target, false);
  await fsp.mkdir(path.dirname(target), { recursive: true });
  try {
    await copyDirectoryRobocopy(source, target, onPulse);
  } catch {
    await fsp.cp(source, target, { recursive: true, force: true });
  }
}

async function moveDirectory(source: string, target: string): Promise<void> {
  await fsp.mkdir(path.dirname(target), { recursive: true });
  try {
    await fsp.rename(source, target);
  } catch (err) {
    const code = err instanceof Error ? (err as NodeJS.ErrnoException).code : undefined;
    if (code === 'EXDEV' || code === 'EPERM') {
      await copyDirectory(source, target);
      await removeDirectory(source, false);
      return;
    }
    throw err;
  }
}

async function promoteStagingToInstall(
  stagingPath: string,
  installPath: string,
  report: ProgressCallback
): Promise<void> {
  await fsp.mkdir(path.dirname(installPath), { recursive: true });

  if (fs.existsSync(installPath)) {
    report({ stage: 'install', percent: 52, message: 'Освобождение папки установки...' });
    await yieldToEventLoop();

    const retiredPath = `${installPath}.retired-${Date.now()}`;
    try {
      await fsp.rename(installPath, retiredPath);
      void removeDirectory(retiredPath, false).catch(() => undefined);
    } catch {
      report({ stage: 'install', percent: 54, message: 'Остановка процессов и очистка...' });
      await yieldToEventLoop();
      await removeDirectory(installPath, true);
    }
  }

  report({ stage: 'install', percent: 58, message: 'Перенос в папку установки...' });
  await yieldToEventLoop();

  try {
    await fsp.rename(stagingPath, installPath);
    return;
  } catch (err) {
    const code = err instanceof Error ? (err as NodeJS.ErrnoException).code : undefined;
    if (code !== 'EXDEV' && code !== 'EPERM') throw err;
  }

  report({ stage: 'install', percent: 62, message: 'Копирование файлов установки...' });
  await copyDirectory(stagingPath, installPath, () => {
    report({ stage: 'install', percent: 68, message: 'Копирование файлов установки...' });
  });
  await removeDirectory(stagingPath, false);
}

function createDownloadTempDir(installBase: string): string {
  const candidates = [installBase, path.join(os.homedir(), 'zapret'), os.tmpdir()];
  for (const base of candidates) {
    if (!base) continue;
    try {
      fs.mkdirSync(base, { recursive: true });
      return fs.mkdtempSync(path.join(base, 'zapret-download-'));
    } catch {
      /* try next location */
    }
  }
  return fs.mkdtempSync(path.join(os.tmpdir(), 'zapret-download-'));
}

export function getInstallPath(installBase: string, version: string): string {
  return path.join(installBase, `zapret-discord-youtube-${version}`);
}

export function getDefaultInstallBase(): string {
  const appRoot = path.join(__dirname, '..', '..');
  const parent = path.dirname(appRoot);
  if (/[^\x00-\x7F]/.test(parent)) {
    return path.join(os.homedir(), 'zapret');
  }
  return parent;
}

export function readInstalledVersion(root: string): string | null {
  if (!root || !fs.existsSync(root)) return null;

  const folderMatch = path.basename(root).match(/zapret-discord-youtube-(\d+\.\d+\.\d+)/i);
  if (folderMatch) return folderMatch[1];

  const serviceBat = path.join(root, 'service.bat');
  if (fs.existsSync(serviceBat)) {
    const content = fs.readFileSync(serviceBat, 'utf8');
    const match = content.match(/LOCAL_VERSION=(\d+\.\d+\.\d+)/i);
    if (match) return match[1];
  }

  return null;
}

export async function downloadOfficialZapret(
  installBase: string,
  existingRoot: string | null,
  onProgress: ProgressCallback
): Promise<{ installPath: string; version: string }> {
  const report = createProgressReporter(onProgress);

  report({ stage: 'fetch', percent: 0, message: 'Получение информации о релизе...' });
  await yieldToEventLoop();
  const release = await fetchLatestRelease();
  report({ stage: 'fetch', percent: 100, message: `Найден релиз ${release.version}` });

  const installPath = getInstallPath(installBase, release.version);
  const tempDir = createDownloadTempDir(installBase);
  const zipPath = path.join(tempDir, release.zipName);
  const extractDir = path.join(tempDir, 'extract');

  try {
    report({
      stage: 'download',
      percent: 0,
      message: `Загрузка ${release.zipName} с GitHub...`,
    });
    await downloadFile(release.zipUrl, zipPath, report);

    await yieldToEventLoop();
    await extractZip(zipPath, extractDir, report);

    report({ stage: 'install', percent: 5, message: 'Подготовка установки...' });
    await yieldToEventLoop();
    const extractedRoot = findZapretRoot(extractDir);
    if (!extractedRoot) {
      throw new Error('В архиве не найден winws.exe');
    }

    const backup =
      existingRoot && fs.existsSync(existingRoot) ? backupUserFiles(existingRoot) : new Map<string, Buffer>();

    const stagingPath = path.join(tempDir, 'staging');
    report({ stage: 'install', percent: 25, message: 'Подготовка файлов...' });
    await yieldToEventLoop();
    await moveDirectory(extractedRoot, stagingPath);
    await promoteStagingToInstall(stagingPath, installPath, report);

    report({ stage: 'install', percent: 75, message: 'Восстановление списков...' });
    restoreUserFiles(installPath, backup);
    ensureUserListFiles(installPath);
    await yieldToEventLoop();

    report({ stage: 'install', percent: 90, message: 'Разблокировка winws.exe...' });
    await unblockZapretBinaries(installPath);
    await removeFileQuiet(path.join(installBase, release.zipName));

    report({
      stage: 'done',
      percent: 100,
      message: `Zapret ${release.version} установлен`,
    });

    return { installPath, version: release.version };
  } finally {
    await removeDirectory(tempDir, false).catch(() => undefined);
  }
}

export async function fetchLatestVersion(): Promise<string | null> {
  try {
    const release = await fetchLatestRelease();
    return release.version;
  } catch {
    return null;
  }
}
