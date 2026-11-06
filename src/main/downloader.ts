import { spawn } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import fsp from 'fs/promises';
import os from 'os';
import path from 'path';
import { decodeProcessOutput, runHidden } from './exec';
import { removeDirectoryRobust } from './fs-remove';
import { describeNetworkError, downloadWithRetry, httpFetch } from './http';
import { readIpsetMode, switchIpsetFiles, type IpsetMode } from './ipset-files';
import { ensureUserListFiles } from './user-lists';

export const GITHUB_REPO = 'Flowseal/zapret-discord-youtube';
export const GITHUB_RELEASES_URL = `https://github.com/${GITHUB_REPO}/releases/latest`;
const VERSION_FILE_URL = `https://raw.githubusercontent.com/${GITHUB_REPO}/main/.service/version.txt`;
const RELEASE_LOOKUP_TIMEOUT_MS = 15_000;

export interface ReleaseInfo {
  version: string;
  zipUrl: string;
  zipName: string;
  /** считает сам GitHub; в запасном пути без API его нет */
  sha256: string | null;
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
    const stderr: Buffer[] = [];
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d: Buffer) => stderr.push(d));
    child.on('close', (code) => {
      if (code === 0) resolve(stdout);
      // Ошибки PowerShell приходят в кодировке консоли: без декодирования вместо причины будут кракозябры
      else reject(new Error(decodeProcessOutput(Buffer.concat(stderr)).trim() || `PowerShell exited with code ${code}`));
    });
    child.on('error', reject);
  });
}

function psQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

async function fetchReleaseFromApi(): Promise<ReleaseInfo> {
  const response = await httpFetch(`https://api.github.com/repos/${GITHUB_REPO}/releases/latest`, {
    headers: { 'User-Agent': 'zapret-app', Accept: 'application/vnd.github+json' },
    signal: AbortSignal.timeout(RELEASE_LOOKUP_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  const data = (await response.json()) as {
    tag_name: string;
    html_url: string;
    assets: Array<{ name: string; browser_download_url: string; digest?: string | null }>;
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
    sha256: zipAsset.digest?.match(/^sha256:([0-9a-f]{64})$/i)?.[1]?.toLowerCase() ?? null,
    releasePage: data.html_url,
  };
}

/** Версия из того же файла, что читает service.bat: у API лимит 60 запросов в час на IP, а за NAT он общий */
async function fetchReleaseFromVersionFile(): Promise<ReleaseInfo> {
  const response = await httpFetch(VERSION_FILE_URL, {
    headers: { 'User-Agent': 'zapret-app' },
    signal: AbortSignal.timeout(RELEASE_LOOKUP_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);

  const version = (await response.text()).trim();
  if (!/^\d+\.\d+\.\d+[a-z]?$/i.test(version)) throw new Error('Неверный формат version.txt');

  const zipName = `zapret-discord-youtube-${version}.zip`;
  return {
    version,
    zipUrl: `https://github.com/${GITHUB_REPO}/releases/download/${version}/${zipName}`,
    zipName,
    sha256: null,
    releasePage: `https://github.com/${GITHUB_REPO}/releases/tag/${version}`,
  };
}

export async function fetchLatestRelease(): Promise<ReleaseInfo> {
  try {
    return await fetchReleaseFromApi();
  } catch (apiError) {
    try {
      return await fetchReleaseFromVersionFile();
    } catch {
      throw new Error(`Не удалось получить релиз GitHub: ${describeNetworkError(apiError)}`);
    }
  }
}

async function downloadFile(
  url: string,
  dest: string,
  onProgress: ProgressCallback
): Promise<void> {
  const report = createProgressReporter(onProgress);
  let lastPercent = -1;
  let lastReportAt = 0;

  await downloadWithRetry(url, dest, {
    headers: { 'User-Agent': 'zapret-app' },
    onRetry: (attempt, attempts) => {
      report({ stage: 'download', percent: 0, message: `Сбой загрузки, повтор ${attempt}/${attempts}...` });
    },
    onData: (downloaded, total) => {
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
    },
  });
}

function assertChecksum(filePath: string, expected: string | null): void {
  if (!expected) return;
  const actual = crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
  if (actual !== expected) throw new Error('контрольная сумма архива не совпала — файл повреждён при загрузке');
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

const REQUIRED_BINARIES = ['bin/winws.exe', 'bin/WinDivert.dll', 'bin/WinDivert64.sys'];

const ANTIVIRUS_HINT =
  'Обычно их удаляет антивирус: WinDivert считается потенциально нежелательным. Добавьте папку zapret в исключения и скачайте снова.';

/** Проверяем до замены старой установки: без драйвера обход не запустится */
export function assertBinariesPresent(root: string): void {
  const missing = REQUIRED_BINARIES.filter((relative) => !fs.existsSync(path.join(root, relative)));
  if (missing.length > 0) {
    throw new Error(`После распаковки нет файлов: ${missing.join(', ')}. ${ANTIVIRUS_HINT}`);
  }
}

/** null — флага в utils не было: выключенная настройка не должна включиться из нового архива */
export function backupUserFiles(sourceRoot: string): Map<string, Buffer | null> {
  const backup = new Map<string, Buffer | null>();
  for (const relativePath of USER_FILES) {
    const fullPath = path.join(sourceRoot, relativePath);
    if (fs.existsSync(fullPath)) {
      backup.set(relativePath, fs.readFileSync(fullPath));
    } else if (relativePath.startsWith('utils/')) {
      backup.set(relativePath, null);
    }
  }
  return backup;
}

export function restoreUserFiles(targetRoot: string, backup: Map<string, Buffer | null>): void {
  for (const [relativePath, content] of backup) {
    const fullPath = path.join(targetRoot, relativePath);
    if (content === null) {
      fs.rmSync(fullPath, { force: true });
      continue;
    }
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content);
  }
}

function detectIpsetMode(root: string): IpsetMode | null {
  try {
    return readIpsetMode(path.join(root, 'lists'));
  } catch {
    return null;
  }
}

/** Старая папка уже заменена, поэтому сбой здесь не должен срывать установку */
export function restoreIpsetMode(root: string, mode: IpsetMode | null): void {
  if (!mode) return;
  try {
    switchIpsetFiles(path.join(root, 'lists'), mode);
  } catch {
    /* останется режим из архива */
  }
}

async function removeFileQuiet(filePath: string): Promise<void> {
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch {
    /* ignore */
  }
}

/** Только системный bsdtar: GNU tar из Git и MSYS принимает «C:\...» за хост и не умеет ZIP */
export function systemTarPath(systemRoot: string = process.env.SystemRoot ?? 'C:\\Windows'): string {
  return path.win32.join(systemRoot, 'System32', 'tar.exe');
}

export async function extractZipWithTar(zipPath: string, destDir: string): Promise<void> {
  await runHidden(systemTarPath(), ['-xf', zipPath, '-C', destDir], { timeoutMs: 120_000 });
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function extractZip(zipPath: string, destDir: string, onProgress: ProgressCallback): Promise<void> {
  const report = createProgressReporter(onProgress);
  report({ stage: 'extract', percent: 0, message: 'Распаковка архива...' });
  await fsp.mkdir(destDir, { recursive: true });

  const script = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Expand-Archive -LiteralPath ${psQuote(zipPath)} -DestinationPath ${psQuote(destDir)} -Force
`.trim();

  try {
    await runPowerShell(script);
  } catch (expandError) {
    // Expand-Archive бывает недоступен: повреждён модуль или PowerShell урезан политикой
    try {
      await extractZipWithTar(zipPath, destDir);
    } catch (tarError) {
      throw new Error(
        `Не удалось распаковать архив: ${errorText(expandError)}; tar: ${errorText(tarError)}. ${ANTIVIRUS_HINT}`
      );
    }
  }
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
  // Метку «из интернета» ставят браузеры, а не мы: без этого шага zapret всё равно запустится
  await runPowerShell(script).catch(() => undefined);
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

/** Сразу после распаковки файлы держит антивирус, и rename на Windows отказывает любым из этих кодов */
function isRenameBlocked(err: unknown): boolean {
  const code = err instanceof Error ? (err as NodeJS.ErrnoException).code : undefined;
  return code === 'EXDEV' || code === 'EPERM' || code === 'EACCES' || code === 'EBUSY';
}

async function moveDirectory(source: string, target: string): Promise<void> {
  await fsp.mkdir(path.dirname(target), { recursive: true });
  try {
    await fsp.rename(source, target);
  } catch (err) {
    if (!isRenameBlocked(err)) throw err;
    await copyDirectory(source, target);
    await removeDirectory(source, false);
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
    if (!isRenameBlocked(err)) throw err;
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

/** Папка установки упакованного приложения (там, где Skvoz.exe); в разработке — null */
function packagedAppDir(): string | null {
  const appRoot = path.join(__dirname, '..', '..');
  return /\.asar$/i.test(appRoot) ? path.dirname(path.dirname(appRoot)) : null;
}

/** Лежит ли путь внутри папки установки — её установщик очищает при каждом обновлении */
export function isInsideAppInstall(target: string): boolean {
  const dir = packagedAppDir();
  if (!dir || !target) return false;
  const rel = path.relative(dir, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

export function getDefaultInstallBase(): string {
  // Раньше zapret качался в resources рядом с app.asar, а установщик при обновлении
  // переносит из папки установки все файлы — zapret вместе со списками пропадал.
  // ProgramData всегда латиницей, а приложение и так работает от администратора.
  if (packagedAppDir()) {
    return path.join(process.env.ProgramData || 'C:\\ProgramData', 'Skvoz');
  }
  const appRoot = path.join(__dirname, '..', '..');
  const parent = path.dirname(appRoot);
  if (/[^\x00-\x7F]/.test(parent)) {
    return path.join(os.homedir(), 'zapret');
  }
  return parent;
}

export function readInstalledVersion(root: string): string | null {
  if (!root || !fs.existsSync(root)) return null;

  // Буква — часть версии (1.9.9d): без неё автообновление каждый раз считало релиз новым
  const folderMatch = path.basename(root).match(/zapret-discord-youtube-(\d+\.\d+\.\d+[a-z]?)/i);
  if (folderMatch) return folderMatch[1];

  const serviceBat = path.join(root, 'service.bat');
  if (fs.existsSync(serviceBat)) {
    const content = fs.readFileSync(serviceBat, 'utf8');
    const match = content.match(/LOCAL_VERSION=(\d+\.\d+\.\d+[a-z]?)/i);
    if (match) return match[1];
  }

  return null;
}

function withManualInstallHint(reason: string): Error {
  return new Error(`${reason}. Можно поставить вручную: скачайте ZIP с ${GITHUB_RELEASES_URL}, распакуйте и нажмите «Найти на ПК».`);
}

/** Распаковывает архив из tempDir и ставит его на место; существующая установка меняется только в самом конце */
async function installFromZip(
  zipPath: string,
  version: string,
  tempDir: string,
  installBase: string,
  existingRoot: string | null,
  report: ProgressCallback
): Promise<{ installPath: string; version: string }> {
  const installPath = getInstallPath(installBase, version);
  const extractDir = path.join(tempDir, 'extract');

  await yieldToEventLoop();
  await extractZip(zipPath, extractDir, report);

  report({ stage: 'install', percent: 5, message: 'Подготовка установки...' });
  await yieldToEventLoop();
  const extractedRoot = findZapretRoot(extractDir);
  if (!extractedRoot) {
    throw new Error(`После распаковки нет bin/winws.exe. ${ANTIVIRUS_HINT}`);
  }
  assertBinariesPresent(extractedRoot);

  const hasExisting = !!existingRoot && fs.existsSync(existingRoot);
  const backup = hasExisting ? backupUserFiles(existingRoot) : new Map<string, Buffer | null>();
  // Читаем до замены: при переустановке той же версии старая папка уйдёт в .retired
  const ipsetMode = hasExisting ? detectIpsetMode(existingRoot) : null;

  const stagingPath = path.join(tempDir, 'staging');
  report({ stage: 'install', percent: 25, message: 'Подготовка файлов...' });
  await yieldToEventLoop();
  await moveDirectory(extractedRoot, stagingPath);
  await promoteStagingToInstall(stagingPath, installPath, report);

  report({ stage: 'install', percent: 75, message: 'Восстановление списков...' });
  restoreUserFiles(installPath, backup);
  ensureUserListFiles(installPath);
  restoreIpsetMode(installPath, ipsetMode);
  await yieldToEventLoop();

  report({ stage: 'install', percent: 90, message: 'Разблокировка winws.exe...' });
  await unblockZapretBinaries(installPath);

  report({ stage: 'done', percent: 100, message: `Zapret ${version} установлен` });
  return { installPath, version };
}

export async function downloadOfficialZapret(
  installBase: string,
  existingRoot: string | null,
  onProgress: ProgressCallback
): Promise<{ installPath: string; version: string }> {
  const report = createProgressReporter(onProgress);

  report({ stage: 'fetch', percent: 0, message: 'Получение информации о релизе...' });
  await yieldToEventLoop();
  const release = await fetchLatestRelease().catch((error) => {
    throw withManualInstallHint(error instanceof Error ? error.message : String(error));
  });
  report({ stage: 'fetch', percent: 100, message: `Найден релиз ${release.version}` });

  const tempDir = createDownloadTempDir(installBase);
  const zipPath = path.join(tempDir, release.zipName);

  try {
    report({
      stage: 'download',
      percent: 0,
      message: `Загрузка ${release.zipName} с GitHub...`,
    });
    try {
      await downloadFile(release.zipUrl, zipPath, report);
      assertChecksum(zipPath, release.sha256);
    } catch (error) {
      throw withManualInstallHint(`Не удалось скачать zapret: ${describeNetworkError(error)}`);
    }

    return await installFromZip(zipPath, release.version, tempDir, installBase, existingRoot, report);
  } finally {
    await removeDirectory(tempDir, false).catch(() => undefined);
  }
}

export interface BundledZapret {
  zipPath: string;
  version: string;
  sha256: string;
}

/** Архив, который едет внутри Skvoz: без него новый пользователь зависит от доступа к GitHub */
export function readBundledZapret(resourcesDir: string | undefined = process.resourcesPath): BundledZapret | null {
  if (!resourcesDir) return null;
  const dir = path.join(resourcesDir, 'zapret');
  try {
    const zipPath = path.join(dir, 'zapret.zip');
    if (!fs.existsSync(zipPath)) return null;
    return {
      zipPath,
      version: fs.readFileSync(path.join(dir, 'VERSION'), 'utf8').trim(),
      sha256: fs.readFileSync(path.join(dir, 'SHA256'), 'utf8').trim().toLowerCase(),
    };
  } catch {
    return null;
  }
}

async function installBundledZapret(
  bundled: BundledZapret,
  installBase: string,
  onProgress: ProgressCallback
): Promise<{ installPath: string; version: string }> {
  const report = createProgressReporter(onProgress);
  report({ stage: 'install', percent: 0, message: `Установка zapret ${bundled.version}...` });

  const tempDir = createDownloadTempDir(installBase);
  try {
    assertChecksum(bundled.zipPath, bundled.sha256);
    // extractZip удаляет архив после распаковки, поэтому работаем с копией
    const zipPath = path.join(tempDir, 'zapret.zip');
    await fsp.copyFile(bundled.zipPath, zipPath);
    return await installFromZip(zipPath, bundled.version, tempDir, installBase, null, report);
  } finally {
    await removeDirectory(tempDir, false).catch(() => undefined);
  }
}

/** Первая установка: сначала встроенный архив, свежую версию потом принесёт автообновление */
export async function installZapret(
  installBase: string,
  onProgress: ProgressCallback
): Promise<{ installPath: string; version: string }> {
  const bundled = readBundledZapret();
  if (bundled) {
    try {
      return await installBundledZapret(bundled, installBase, onProgress);
    } catch {
      /* архив мог повредить антивирус — пробуем скачать */
    }
  }
  return downloadOfficialZapret(installBase, null, onProgress);
}

export async function fetchLatestVersion(): Promise<string | null> {
  try {
    const release = await fetchLatestRelease();
    return release.version;
  } catch {
    return null;
  }
}
