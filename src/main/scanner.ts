import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { readInstalledVersion, getDefaultInstallBase } from './downloader';

export function getAppSearchPaths(): string[] {
  const appRoot = path.join(__dirname, '..', '..');
  const parent = path.dirname(appRoot);
  const installBase = getDefaultInstallBase();
  const roots = new Set<string>([parent, appRoot, installBase]);

  for (const base of [parent, appRoot, installBase]) {
    if (!fs.existsSync(base)) continue;
    try {
      for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        if (/zapret-discord-youtube/i.test(entry.name)) {
          roots.add(path.join(base, entry.name));
        }
      }
    } catch {
      /* ignore unreadable folders */
    }
  }

  return [...roots];
}

export const OFFICIAL_GITHUB_MARKER = 'Flowseal/zapret-discord-youtube';

export interface InstallCandidate {
  path: string;
  version: string | null;
  isOfficial: boolean;
  score: number;
  source: string;
  warnings: string[];
}

export interface ScanResult {
  candidates: InstallCandidate[];
  best: InstallCandidate | null;
  scannedAt: string;
}

const REQUIRED_FILES = [
  'service.bat',
  'general.bat',
  'bin/winws.exe',
  'lists/list-general.txt',
  'utils/test zapret.ps1',
];

const SUSPICIOUS_MARKERS = [
  'discordfix',
  'goodbyedpi',
  'repack',
  'cracked',
  'telegram.me',
  't.me/',
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
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(stderr.trim() || `PowerShell exited with code ${code}`));
    });
    child.on('error', reject);
  });
}

function isZapretCandidate(dir: string): boolean {
  return fs.existsSync(path.join(dir, 'bin', 'winws.exe'));
}

function readTextSafe(filePath: string): string {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return '';
  }
}

export function verifyInstallation(root: string, source: string): InstallCandidate {
  const warnings: string[] = [];
  let score = 0;

  if (!isZapretCandidate(root)) {
    return {
      path: root,
      version: null,
      isOfficial: false,
      score: 0,
      source,
      warnings: ['Не найден bin/winws.exe'],
    };
  }

  for (const relative of REQUIRED_FILES) {
    if (fs.existsSync(path.join(root, relative))) score += 12;
    else warnings.push(`Отсутствует ${relative}`);
  }

  const serviceBat = path.join(root, 'service.bat');
  const serviceContent = readTextSafe(serviceBat);
  const hasOfficialMarker = serviceContent.includes(OFFICIAL_GITHUB_MARKER);

  if (hasOfficialMarker) score += 35;
  else warnings.push('Нет ссылки на официальный GitHub Flowseal/zapret-discord-youtube');

  if (/LOCAL_VERSION=\d+\.\d+\.\d+/i.test(serviceContent)) score += 8;
  else warnings.push('Не найден LOCAL_VERSION в service.bat');

  if (/^zapret-discord-youtube-\d+\.\d+\.\d+$/i.test(path.basename(root))) score += 10;
  else warnings.push('Имя папки не соответствует официальному формату');

  if (fs.existsSync(path.join(root, 'LICENSE.txt'))) score += 4;

  const lowerContent = readTextSafe(path.join(root, 'README.md')).toLowerCase();
  const folderLower = path.basename(root).toLowerCase();

  if (!hasOfficialMarker) {
    const combined = `${serviceContent}\n${lowerContent}`.toLowerCase();
    for (const marker of SUSPICIOUS_MARKERS) {
      if (combined.includes(marker) || folderLower.includes(marker)) {
        score -= 25;
        warnings.push(`Подозрительный маркер: ${marker}`);
      }
    }
    warnings.push('Возможная неофициальная или изменённая сборка');
  } else if (lowerContent.includes('фейк') || folderLower.includes('repack')) {
    warnings.push('Проверьте источник сборки, даже при наличии официальных маркеров');
  }

  const version = readInstalledVersion(root);
  const missingRequired = REQUIRED_FILES.filter((relative) => !fs.existsSync(path.join(root, relative))).length;
  const isOfficial = hasOfficialMarker && missingRequired <= 1 && score >= 60;

  return {
    path: path.resolve(root),
    version,
    isOfficial,
    score,
    source,
    warnings,
  };
}

async function getRunningWinwsDirectory(): Promise<string | null> {
  try {
    const output = await runPowerShell(
      `$p = Get-Process winws -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty Path; if ($p) { Split-Path $p -Parent | Split-Path -Parent }`
    );
    return output && fs.existsSync(output) ? output : null;
  } catch {
    return null;
  }
}

async function getServiceDirectory(): Promise<string | null> {
  try {
    const output = await runPowerShell(`
$output = sc.exe qc zapret 2>$null
if ($output -match 'BINARY_PATH_NAME\\s*:\\s*(.+)') {
  $path = $Matches[1].Trim()
  $path = $path.Trim('"')
  if ($path -match 'winws\\.exe') {
    Split-Path (Split-Path $path -Parent) -Parent
  }
}
`.trim());
    return output && fs.existsSync(output) ? output : null;
  } catch {
    return null;
  }
}

async function getDriveRoots(): Promise<string[]> {
  try {
    const output = await runPowerShell(
      `[Console]::Out.Write([string]::Join('|', (Get-PSDrive -PSProvider FileSystem).Root))`
    );
    return output.split('|').filter(Boolean);
  } catch {
    return ['C:\\'];
  }
}

function getUserSearchRoots(): string[] {
  const home = os.homedir();
  return [
    home,
    path.join(home, 'Desktop'),
    path.join(home, 'Downloads'),
    path.join(home, 'Documents'),
    path.join(home, 'Videos'),
    path.join(home, 'zapret'),
    path.join(home, 'Apps'),
    path.join(home, 'AppData', 'Local'),
  ];
}

const SKIP_DIR_NAMES = new Set([
  'windows',
  'program files',
  'program files (x86)',
  'programdata',
  '$recycle.bin',
  'system volume information',
  'node_modules',
  '.git',
  'appdata',
  'temp',
  'cache',
]);

function shouldSkipDir(name: string, depth: number): boolean {
  const lower = name.toLowerCase();
  if (SKIP_DIR_NAMES.has(lower)) return true;
  if (depth > 5) return true;
  if (lower.startsWith('$')) return true;
  return false;
}

function collectFromDirectory(baseDir: string, maxDepth: number, found: Map<string, string>): void {
  if (!fs.existsSync(baseDir)) return;

  const queue: Array<{ dir: string; depth: number }> = [{ dir: baseDir, depth: 0 }];
  const visited = new Set<string>();

  while (queue.length > 0) {
    const current = queue.shift()!;
    const normalized = path.resolve(current.dir).toLowerCase();
    if (visited.has(normalized)) continue;
    visited.add(normalized);

    if (isZapretCandidate(current.dir)) {
      found.set(path.resolve(current.dir), 'disk-scan');
      continue;
    }

    if (current.depth >= maxDepth) continue;

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current.dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (shouldSkipDir(entry.name, current.depth + 1)) continue;

      const fullPath = path.join(current.dir, entry.name);
      const nameLower = entry.name.toLowerCase();

      if (/zapret|discord.*youtube|winws|dpi/i.test(nameLower)) {
        queue.push({ dir: fullPath, depth: current.depth + 1 });
        continue;
      }

      if (current.depth < 2) {
        queue.push({ dir: fullPath, depth: current.depth + 1 });
      }
    }
  }
}

function pickBest(candidates: InstallCandidate[], installBase?: string): InstallCandidate | null {
  if (candidates.length === 0) return null;

  const normalizedBase = installBase ? path.resolve(installBase).toLowerCase() : '';

  return [...candidates].sort((a, b) => {
    if (a.isOfficial !== b.isOfficial) return a.isOfficial ? -1 : 1;

    const localA = normalizedBase && a.path.toLowerCase().startsWith(normalizedBase) ? 1 : 0;
    const localB = normalizedBase && b.path.toLowerCase().startsWith(normalizedBase) ? 1 : 0;
    if (localA !== localB) return localB - localA;

    const versionA = a.version ?? '0.0.0';
    const versionB = b.version ?? '0.0.0';
    if (versionA !== versionB) return versionB.localeCompare(versionA, undefined, { numeric: true });
    return b.score - a.score;
  })[0];
}

/**
 * Служба или процесс могут указывать на папку, откуда антивирус уже убрал winws.exe.
 * Такая папка не установка: иначе автоустановка считала бы, что zapret найден
 */
export function dropMissingInstalls(candidates: InstallCandidate[]): InstallCandidate[] {
  return candidates.filter((candidate) => isZapretCandidate(candidate.path));
}

export async function scanForInstallations(
  extraPaths: string[] = [],
  installBase?: string,
  options: { deep?: boolean } = {}
): Promise<ScanResult> {
  const found = new Map<string, string>();
  const searchBase = installBase ?? getDefaultInstallBase();
  const deep = options.deep ?? false;

  const [runningDir, serviceDir] = await Promise.all([
    getRunningWinwsDirectory(),
    getServiceDirectory(),
  ]);

  if (runningDir) found.set(path.resolve(runningDir), 'running-process');
  if (serviceDir) found.set(path.resolve(serviceDir), 'windows-service');

  for (const extra of [...getAppSearchPaths(), ...extraPaths]) {
    if (!extra || !fs.existsSync(extra)) continue;
    const root = isZapretCandidate(extra) ? extra : findNestedInstall(extra);
    if (root) found.set(path.resolve(root), 'app-folder');
  }

  for (const root of getUserSearchRoots()) {
    collectFromDirectory(root, deep ? 4 : 2, found);
  }

  if (deep) {
    const drives = await getDriveRoots();
    for (const drive of drives) {
      collectFromDirectory(drive, 2, found);
    }
  }

  const candidates = [...found.entries()].map(([installPath, source]) =>
    verifyInstallation(installPath, source)
  );

  const unique = new Map<string, InstallCandidate>();
  for (const candidate of candidates) {
    const existing = unique.get(candidate.path);
    if (!existing || candidate.score > existing.score) unique.set(candidate.path, candidate);
  }

  const list = dropMissingInstalls([...unique.values()]);
  return {
    candidates: list.sort((a, b) => b.score - a.score),
    best: pickBest(list, searchBase),
    scannedAt: new Date().toISOString(),
  };
}

function findNestedInstall(baseDir: string): string | null {
  if (isZapretCandidate(baseDir)) return baseDir;

  if (!fs.existsSync(baseDir)) return null;

  for (const entry of fs.readdirSync(baseDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const candidate = path.join(baseDir, entry.name);
    if (isZapretCandidate(candidate)) return candidate;
    if (/zapret-discord-youtube/i.test(entry.name) && fs.existsSync(candidate)) {
      const nested = findNestedInstall(candidate);
      if (nested) return nested;
    }
  }

  return null;
}

export function resolveBestPath(scan: ScanResult, preferredPath?: string): InstallCandidate | null {
  if (preferredPath && fs.existsSync(preferredPath)) {
    const verified = verifyInstallation(preferredPath, 'preferred');
    if (verified.score > 0) return verified;
  }
  return scan.best;
}
