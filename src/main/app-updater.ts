import { app } from 'electron';
import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { STARTUP_LAUNCH_ARG } from './autostart';
import { compareVersions, normalizeVersion } from './version-utils';
import type { DownloadProgress } from './downloader';

export const APP_GITHUB_REPO = 'tw1xtyq/skvoz';

export type AppUpdateKind = 'source' | 'portable' | 'setup';

export interface AppReleaseInfo {
  version: string;
  downloadUrl: string;
  fileName: string;
  releasePage: string;
  releaseNotes: string;
  kind: AppUpdateKind;
}

export interface AppUpdateStatus {
  current: string;
  latest: string | null;
  upToDate: boolean;
  checkFailed?: boolean;
  releasePage: string | null;
  releaseNotes: string | null;
}

export interface PendingAppUpdate {
  stagingPath: string;
  version: string;
  kind: AppUpdateKind;
}

type ProgressCallback = (progress: DownloadProgress) => void;

function psQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

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

function writeUpdaterScript(script: string): string {
  const updaterPath = path.join(os.tmpdir(), `zapret-app-apply-${Date.now()}.ps1`);
  fs.writeFileSync(updaterPath, `\uFEFF${script}`, 'utf8');
  return updaterPath;
}

function spawnUpdaterScript(updaterPath: string): void {
  spawn(
    'powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', updaterPath],
    {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    }
  ).unref();
}

function launchInstalledAppPs(exePath: string): string {
  const exe = psQuote(exePath);
  const dir = psQuote(path.dirname(exePath));
  const startupArg = psQuote(STARTUP_LAUNCH_ARG);
  return `
if (-not (Test-Path -LiteralPath ${exe})) {
  throw "Не найден файл приложения: ${exePath.replace(/'/g, "''")}"
}
Start-Process -LiteralPath ${exe} -WorkingDirectory ${dir} -ArgumentList ${startupArg}
`.trim();
}

function scheduleUpdater(scriptBody: string): void {
  const updaterPath = writeUpdaterScript(scriptBody);
  spawnUpdaterScript(updaterPath);
}

export function getAppRoot(): string {
  if (app.isPackaged) {
    return path.dirname(process.execPath);
  }
  return app.getAppPath();
}

export function getCurrentAppVersion(): string {
  try {
    const pkgPath = path.join(app.getAppPath(), 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { version?: string };
    return normalizeVersion(pkg.version ?? '0.0.0');
  } catch {
    return '0.0.0';
  }
}

function isInstalledViaNsis(): boolean {
  if (!app.isPackaged) return false;
  const exeDir = path.dirname(process.execPath);
  if (['Uninstall Skvoz.exe', 'Uninstall Zapret App.exe'].some((name) => fs.existsSync(path.join(exeDir, name)))) return true;
  const exe = process.execPath.toLowerCase();
  return exe.includes('\\program files\\') || exe.includes('\\program files (x86)\\');
}

function preferredUpdateKind(): AppUpdateKind {
  if (!app.isPackaged) return 'source';
  return isInstalledViaNsis() ? 'setup' : 'portable';
}

function pickReleaseAsset(
  assets: Array<{ name: string; browser_download_url: string }>,
  kind: AppUpdateKind
): { name: string; browser_download_url: string } | null {
  const portable = assets.find(
    (asset) => /portable/i.test(asset.name) && asset.name.endsWith('.exe')
  );
  const setup = assets.find(
    (asset) => /setup/i.test(asset.name) && asset.name.endsWith('.exe')
  );
  const zip = assets.find((asset) => /zapret-app/i.test(asset.name) && asset.name.endsWith('.zip'));

  if (kind === 'portable') return portable ?? setup ?? zip ?? null;
  if (kind === 'setup') return setup ?? portable ?? zip ?? null;
  return zip ?? portable ?? setup ?? null;
}

export async function fetchLatestAppRelease(kind = preferredUpdateKind()): Promise<AppReleaseInfo> {
  const response = await fetch(`https://api.github.com/repos/${APP_GITHUB_REPO}/releases/latest`, {
    headers: { 'User-Agent': 'zapret-app', Accept: 'application/vnd.github+json' },
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) {
    throw new Error(`Не удалось получить релиз Skvoz: HTTP ${response.status}`);
  }

  const data = (await response.json()) as {
    tag_name: string;
    html_url: string;
    body: string | null;
    assets: Array<{ name: string; browser_download_url: string }>;
  };

  const version = normalizeVersion(data.tag_name);
  const asset = pickReleaseAsset(data.assets, kind);

  let downloadUrl = asset?.browser_download_url ?? '';
  let fileName = asset?.name ?? '';
  let resolvedKind = kind;

  if (!asset) {
    downloadUrl = `https://github.com/${APP_GITHUB_REPO}/archive/refs/tags/v${version}.zip`;
    fileName = `Zapret-App-${version}.zip`;
    resolvedKind = 'source';
  } else if (/\.zip$/i.test(asset.name)) {
    resolvedKind = 'source';
  } else if (/setup/i.test(asset.name)) {
    resolvedKind = 'setup';
  } else if (/portable/i.test(asset.name)) {
    resolvedKind = 'portable';
  }

  return {
    version,
    downloadUrl,
    fileName,
    releasePage: data.html_url,
    releaseNotes: (data.body ?? '').trim(),
    kind: resolvedKind,
  };
}

export async function checkAppUpdate(): Promise<AppUpdateStatus> {
  const current = getCurrentAppVersion();

  try {
    const release = await fetchLatestAppRelease();
    const upToDate = compareVersions(current, release.version) >= 0;
    return {
      current,
      latest: release.version,
      upToDate,
      releasePage: release.releasePage,
      releaseNotes: release.releaseNotes || null,
    };
  } catch {
    return {
      current,
      latest: null,
      upToDate: false,
      checkFailed: true,
      releasePage: null,
      releaseNotes: null,
    };
  }
}

function findAppRoot(dir: string): string | null {
  const pkgPath = path.join(dir, 'package.json');
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { name?: string };
      if (pkg.name === 'zapret-app') return dir;
    } catch {
      /* ignore */
    }
  }

  if (!fs.existsSync(dir)) return null;

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const found = findAppRoot(path.join(dir, entry.name));
    if (found) return found;
  }

  return null;
}

async function downloadFile(url: string, dest: string, onProgress: ProgressCallback): Promise<void> {
  const response = await fetch(url, {
    headers: { 'User-Agent': 'zapret-app' },
    redirect: 'follow',
  });

  if (!response.ok || !response.body) {
    throw new Error(`Ошибка загрузки обновления: HTTP ${response.status}`);
  }

  const total = parseInt(response.headers.get('content-length') ?? '0', 10);
  const reader = response.body.getReader();
  const file = fs.createWriteStream(dest);
  let downloaded = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    downloaded += value.length;
    file.write(Buffer.from(value));
    const percent = total > 0 ? Math.min(99, Math.round((downloaded / total) * 100)) : 0;
    onProgress({
      stage: 'download',
      percent,
      message: total > 0 ? `Загрузка обновления: ${percent}%` : 'Загрузка обновления...',
    });
  }

  await new Promise<void>((resolve, reject) => {
    file.end(() => resolve());
    file.on('error', reject);
  });
}

async function extractZip(zipPath: string, destDir: string, onProgress: ProgressCallback): Promise<void> {
  onProgress({ stage: 'extract', percent: 0, message: 'Распаковка обновления...' });
  fs.mkdirSync(destDir, { recursive: true });

  const script = `
$ErrorActionPreference = 'Stop'
Expand-Archive -LiteralPath ${psQuote(zipPath)} -DestinationPath ${psQuote(destDir)} -Force
`.trim();

  await runPowerShell(script);
  onProgress({ stage: 'extract', percent: 100, message: 'Обновление распаковано' });
}

export async function downloadAppUpdate(onProgress: ProgressCallback): Promise<PendingAppUpdate> {
  const kind = preferredUpdateKind();
  const release = await fetchLatestAppRelease(kind);
  const current = getCurrentAppVersion();

  if (compareVersions(current, release.version) >= 0) {
    throw new Error('У вас уже установлена последняя версия Skvoz');
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zapret-app-update-'));
  const destPath = path.join(tempDir, release.fileName || `Zapret-App-${release.version}`);

  onProgress({ stage: 'fetch', percent: 0, message: `Загрузка Skvoz ${release.version}...` });
  await downloadFile(release.downloadUrl, destPath, onProgress);

  if (release.kind === 'source') {
    const extractDir = path.join(tempDir, 'extract');
    await extractZip(destPath, extractDir, onProgress);

    const stagingPath = findAppRoot(extractDir);
    if (!stagingPath) {
      throw new Error('В архиве обновления не найден package.json Skvoz');
    }

    onProgress({
      stage: 'done',
      percent: 100,
      message: `Готово к установке: v${release.version}`,
    });

    return { stagingPath, version: release.version, kind: 'source' };
  }

  onProgress({
    stage: 'done',
    percent: 100,
    message: `Готово к установке: v${release.version}`,
  });

  return { stagingPath: destPath, version: release.version, kind: release.kind };
}

function scheduleSourceUpdateApply(stagingPath: string): void {
  const appRoot = getAppRoot();
  const launcherBat = path.join(appRoot, 'Skvoz.bat');
  const launcherCmd = path.join(appRoot, 'scripts', 'start-win.cmd');
  const launcher = fs.existsSync(launcherBat) ? launcherBat : launcherCmd;
  const pid = process.pid;

  const script = `
$ErrorActionPreference = 'Stop'
Wait-Process -Id ${pid} -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2

$source = ${psQuote(stagingPath)}
$dest = ${psQuote(appRoot)}
$skip = @('node_modules', 'dist', '.git', 'release')

Get-ChildItem -LiteralPath $source -Force | ForEach-Object {
  if ($skip -contains $_.Name) { return }
  $target = Join-Path $dest $_.Name
  if ($_.PSIsContainer) {
    if (Test-Path $target) { Remove-Item -LiteralPath $target -Recurse -Force }
    Copy-Item -LiteralPath $_.FullName -Destination $target -Recurse -Force
  } else {
    Copy-Item -LiteralPath $_.FullName -Destination $target -Force
  }
}

Set-Location $dest
npm install --no-fund --no-audit | Out-Null
npm run build | Out-Null

$launcher = ${psQuote(launcher)}
if (Test-Path -LiteralPath $launcher) {
  Start-Process -FilePath $launcher -WorkingDirectory $dest -ArgumentList ${psQuote(STARTUP_LAUNCH_ARG)}
} else {
  Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', 'npm start' -WorkingDirectory $dest
}
`.trim();

  scheduleUpdater(script);
}

function schedulePortableUpdateApply(stagingPath: string): void {
  const currentExe = process.execPath;
  const pid = process.pid;

  const script = `
$ErrorActionPreference = 'Stop'
Wait-Process -Id ${pid} -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2

$source = ${psQuote(stagingPath)}
$target = ${psQuote(currentExe)}
$backup = "$target.bak"
$replaced = $false

for ($attempt = 0; $attempt -lt 12; $attempt++) {
  try {
    if (Test-Path -LiteralPath $backup) { Remove-Item -LiteralPath $backup -Force -ErrorAction SilentlyContinue }
    if (Test-Path -LiteralPath $target) { Move-Item -LiteralPath $target -Destination $backup -Force }
    Copy-Item -LiteralPath $source -Destination $target -Force
    $replaced = $true
    break
  } catch {
    Start-Sleep -Seconds 1
  }
}

if (-not $replaced) {
  throw 'Не удалось заменить portable exe. Закройте Skvoz и установите обновление вручную.'
}

${launchInstalledAppPs(currentExe)}

Start-Sleep -Seconds 2
Remove-Item -LiteralPath $backup -Force -ErrorAction SilentlyContinue
`.trim();

  scheduleUpdater(script);
}

function scheduleSetupUpdateApply(stagingPath: string): void {
  const currentExe = process.execPath;
  const pid = process.pid;

  const script = `
$ErrorActionPreference = 'Stop'
Wait-Process -Id ${pid} -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2

$installer = ${psQuote(stagingPath)}
$target = ${psQuote(currentExe)}

$proc = Start-Process -LiteralPath $installer -ArgumentList '/S' -PassThru -Wait
if ($proc.ExitCode -ne 0) {
  throw "Установщик завершился с кодом $($proc.ExitCode)"
}

Start-Sleep -Seconds 1
${launchInstalledAppPs(currentExe)}
`.trim();

  scheduleUpdater(script);
}

export function scheduleAppUpdateApply(update: PendingAppUpdate): void {
  if (update.kind === 'portable') {
    schedulePortableUpdateApply(update.stagingPath);
  } else if (update.kind === 'setup') {
    scheduleSetupUpdateApply(update.stagingPath);
  } else {
    scheduleSourceUpdateApply(update.stagingPath);
  }
}

export function getAppReleasePageUrl(): string {
  return `https://github.com/${APP_GITHUB_REPO}/releases/latest`;
}
