import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import {
  fetchLatestVersion,
  readInstalledVersion,
} from './downloader';
import { scanForInstallations, verifyInstallation } from './scanner';
import { runDiagnosticsInApp } from './diagnostics';
import { runTestsInApp, pickBestStrategy } from './tests-runner';
import {
  startBypassHidden,
} from './service-actions';
import { fullRemoveZapretFromPc } from './uninstall';
import { runHidden } from './exec';

export interface ZapretPaths {
  root: string;
  bin: string;
  lists: string;
  utils: string;
  serviceBat: string;
}

export interface ServiceState {
  exists: boolean;
  running: boolean;
  state: string;
  strategy: string | null;
}

export interface BypassState {
  running: boolean;
  pid: number | null;
}

export interface SettingsState {
  gameFilter: 'disabled' | 'all' | 'tcp' | 'udp';
  ipset: 'loaded' | 'none' | 'any';
  checkUpdates: boolean;
}

export interface ZapretStatus {
  pathsValid: boolean;
  bypass: BypassState;
  zapretService: ServiceState;
  windivertService: ServiceState;
  settings: SettingsState;
  strategies: string[];
  selectedStrategy: string | null;
  installedVersion: string | null;
  latestVersion: string | null;
  updateAvailable: boolean;
  isOfficial: boolean;
  officialWarnings: string[];
  foundInstalls: number;
}

export function getEmptyStatus(): ZapretStatus {
  return {
    pathsValid: false,
    bypass: { running: false, pid: null },
    zapretService: { exists: false, running: false, state: 'NOT_FOUND', strategy: null },
    windivertService: { exists: false, running: false, state: 'NOT_FOUND', strategy: null },
    settings: { gameFilter: 'disabled', ipset: 'none', checkUpdates: false },
    strategies: [],
    selectedStrategy: null,
    installedVersion: null,
    latestVersion: null,
    updateAvailable: false,
    isOfficial: false,
    officialWarnings: [],
    foundInstalls: 0,
  };
}

function runCmd(command: string, args: string[]): Promise<string> {
  const MAX_OUTPUT = 32 * 1024;
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, shell: false });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => {
      if (stdout.length < MAX_OUTPUT) stdout += d.toString();
    });
    child.stderr.on('data', (d: Buffer) => {
      if (stderr.length < MAX_OUTPUT) stderr += d.toString();
    });
    child.on('close', (code: number) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(stderr.trim() || stdout.trim() || `Command failed: ${command} ${args.join(' ')}`));
    });
    child.on('error', reject);
  });
}

export function resolveZapretRoot(customPath?: string): string {
  if (customPath && fs.existsSync(customPath)) {
    return path.resolve(customPath);
  }
  return '';
}

export async function discoverZapretRoot(customPath?: string): Promise<string> {
  if (customPath && fs.existsSync(customPath)) {
    return path.resolve(customPath);
  }

  const scan = await scanForInstallations(customPath ? [customPath] : []);
  return scan.best?.path ?? '';
}

export function getPaths(root: string): ZapretPaths {
  return {
    root,
    bin: path.join(root, 'bin'),
    lists: path.join(root, 'lists'),
    utils: path.join(root, 'utils'),
    serviceBat: path.join(root, 'service.bat'),
  };
}

export function validatePaths(paths: ZapretPaths): boolean {
  return fs.existsSync(paths.bin) && fs.existsSync(path.join(paths.bin, 'winws.exe'));
}

let strategiesCache: { root: string; mtimeMs: number; strategies: string[] } | null = null;

export function listStrategies(root: string): string[] {
  if (!fs.existsSync(root)) return [];

  let mtimeMs = 0;
  try {
    mtimeMs = fs.statSync(root).mtimeMs;
  } catch {
    return [];
  }

  if (strategiesCache?.root === root && strategiesCache.mtimeMs === mtimeMs) {
    return strategiesCache.strategies;
  }

  const strategies = fs
    .readdirSync(root)
    .filter((f) => f.endsWith('.bat') && !f.toLowerCase().startsWith('service'))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));

  strategiesCache = { root, mtimeMs, strategies };
  return strategies;
}

async function queryService(name: string): Promise<ServiceState> {
  try {
    const output = await runCmd('sc', ['query', name]);
    const stateMatch = output.match(/STATE\s+:\s+\d+\s+(\w+)/i);
    if (!stateMatch) {
      return { exists: false, running: false, state: 'NOT_FOUND', strategy: null };
    }
    const state = stateMatch[1];
    return { exists: true, running: state === 'RUNNING', state, strategy: null };
  } catch {
    return { exists: false, running: false, state: 'NOT_FOUND', strategy: null };
  }
}

async function readRegistryStrategy(): Promise<string | null> {
  try {
    const output = await runCmd('reg', [
      'query',
      'HKLM\\System\\CurrentControlSet\\Services\\zapret',
      '/v',
      'zapret-discord-youtube',
    ]);
    const match = output.match(/zapret-discord-youtube\s+REG_SZ\s+(.+)/i);
    return match?.[1]?.trim() ?? null;
  } catch {
    return null;
  }
}

async function isWinwsRunning(): Promise<BypassState> {
  try {
    const output = await runCmd('tasklist', ['/FI', 'IMAGENAME eq winws.exe', '/FO', 'CSV', '/NH']);
    const line = output
      .split(/\r?\n/)
      .map((row) => row.trim())
      .find((row) => /^"winws\.exe"/i.test(row));

    if (!line) {
      return { running: false, pid: null };
    }

    const match = line.match(/"winws\.exe","(\d+)"/i);
    return { running: true, pid: match ? parseInt(match[1], 10) : null };
  } catch {
    return { running: false, pid: null };
  }
}

function readGameFilter(utilsDir: string): SettingsState['gameFilter'] {
  const flagFile = path.join(utilsDir, 'game_filter.enabled');
  if (!fs.existsSync(flagFile)) return 'disabled';
  const mode = fs.readFileSync(flagFile, 'utf8').trim().toLowerCase();
  if (mode === 'all' || mode === 'tcp' || mode === 'udp') return mode;
  return 'disabled';
}

function readIpsetStatus(listsDir: string): SettingsState['ipset'] {
  const listFile = path.join(listsDir, 'ipset-all.txt');
  if (!fs.existsSync(listFile)) return 'any';
  const content = fs.readFileSync(listFile, 'utf8').trim();
  if (!content) return 'any';
  if (content.includes('203.0.113.113/32')) return 'none';
  return 'loaded';
}

function readCheckUpdates(utilsDir: string): boolean {
  return fs.existsSync(path.join(utilsDir, 'check_updates.enabled'));
}

let cachedLatestVersion: { value: string | null; at: number } | null = null;
let statusCache: { root: string; status: ZapretStatus; at: number } | null = null;
let verificationCache: { root: string; isOfficial: boolean; warnings: string[]; at: number } | null = null;

const STATUS_CACHE_MS = 8000;
const STATUS_CACHE_LIGHT_MS = 15_000;
const VERIFICATION_CACHE_MS = 5 * 60_000;

export function invalidateStatusCache(): void {
  statusCache = null;
  strategiesCache = null;
}

async function getLatestVersionCached(): Promise<string | null> {
  if (cachedLatestVersion && Date.now() - cachedLatestVersion.at < 5 * 60 * 1000) {
    return cachedLatestVersion.value;
  }
  try {
    const value = await Promise.race([
      fetchLatestVersion(),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 4000)),
    ]);
    cachedLatestVersion = { value, at: Date.now() };
    return value;
  } catch {
    return cachedLatestVersion?.value ?? null;
  }
}

export async function getStatus(
  root: string,
  options: { fresh?: boolean; light?: boolean } = {}
): Promise<ZapretStatus> {
  const cacheMs = options.light ? STATUS_CACHE_LIGHT_MS : STATUS_CACHE_MS;
  if (
    !options.fresh &&
    statusCache &&
    statusCache.root === root &&
    Date.now() - statusCache.at < cacheMs
  ) {
    return statusCache.status;
  }

  const paths = getPaths(root);
  const pathsValid = validatePaths(paths);
  const strategies = listStrategies(root);
  const installedVersion = readInstalledVersion(root);
  const latestVersion = options.light
    ? cachedLatestVersion?.value ?? null
    : await getLatestVersionCached();

  let isOfficial = false;
  let officialWarnings: string[] = [];
  if (root) {
    const verificationFresh =
      verificationCache &&
      verificationCache.root === root &&
      Date.now() - verificationCache.at < VERIFICATION_CACHE_MS;
    if (verificationFresh || (options.light && verificationCache?.root === root)) {
      isOfficial = verificationCache!.isOfficial;
      officialWarnings = verificationCache!.warnings;
    } else {
      const verification = verifyInstallation(root, 'active');
      isOfficial = verification.isOfficial;
      officialWarnings = verification.warnings;
      verificationCache = { root, isOfficial, warnings: officialWarnings, at: Date.now() };
    }
  }

  const [bypass, zapretServiceRaw, windivertService] = await Promise.all([
    isWinwsRunning(),
    queryService('zapret'),
    queryService('WinDivert'),
  ]);

  const zapretService = { ...zapretServiceRaw };
  if (zapretService.running && !bypass.running) {
    zapretService.running = false;
    zapretService.state = 'NO_PROCESS';
  }

  const strategy =
    zapretServiceRaw.exists && !options.light ? await readRegistryStrategy() : null;
  if (strategy) zapretService.strategy = strategy;

  const settings: SettingsState = {
    gameFilter: readGameFilter(paths.utils),
    ipset: readIpsetStatus(paths.lists),
    checkUpdates: readCheckUpdates(paths.utils),
  };

  let selectedStrategy: string | null = null;
  if (strategy) {
    const match = strategies.find((s) => path.parse(s).name === strategy);
    if (match) selectedStrategy = match;
  }
  if (!selectedStrategy && strategies.includes('general.bat')) {
    selectedStrategy = 'general.bat';
  } else if (!selectedStrategy && strategies.length > 0) {
    selectedStrategy = strategies[0];
  }

  const updateAvailable =
    !!installedVersion && !!latestVersion && installedVersion !== latestVersion;

  const status: ZapretStatus = {
    pathsValid,
    bypass,
    zapretService,
    windivertService,
    settings,
    strategies,
    selectedStrategy,
    installedVersion,
    latestVersion,
    updateAvailable,
    isOfficial,
    officialWarnings,
    foundInstalls: pathsValid ? 1 : 0,
  };

  statusCache = { root, status, at: Date.now() };
  return status;
}

export async function verifyBypassRunning(): Promise<BypassState> {
  return isWinwsRunning();
}

export async function stopBypass(onLine?: (line: { text: string; level: string }) => void): Promise<void> {
  onLine?.({ text: 'Остановка winws.exe...', level: 'info' });
  try {
    await runHidden('taskkill', ['/IM', 'winws.exe', '/F'], {
      onLine: (line) => onLine?.(line),
    });
    onLine?.({ text: '[OK] Обход остановлен', level: 'success' });
  } catch {
    onLine?.({ text: '[OK] winws.exe уже остановлен', level: 'success' });
  } finally {
    invalidateStatusCache();
  }
}

export function startBypass(
  root: string,
  strategyFile: string,
  onLine?: (line: { text: string; level: string }) => void
): Promise<void> {
  invalidateStatusCache();
  return startBypassHidden(root, strategyFile, (line) => onLine?.(line)).finally(() => {
    invalidateStatusCache();
  });
}

export function fullRemoveZapret(
  currentRoot: string | null,
  installBase: string,
  onLine?: (line: { text: string; level: string }) => void
): Promise<{ removedPaths: string[] }> {
  return fullRemoveZapretFromPc(currentRoot, installBase, (line) => onLine?.(line));
}

export async function getProcessStatusReport(
  root: string,
  out: (line: { text: string; level: 'info' | 'success' | 'warn' | 'error' }) => void
): Promise<void> {
  void root;

  const bypass = await isWinwsRunning();
  const status = await getStatus(root);
  const strategy = status.selectedStrategy;

  if (bypass.running) {
    out({
      text: `Обход запущен: winws.exe${bypass.pid ? ` (PID ${bypass.pid})` : ''}`,
      level: 'success',
    });
  } else {
    out({ text: 'Обход остановлен: winws.exe не запущен', level: 'info' });
  }

  if (strategy) {
    out({ text: `Конфиг: ${strategy.replace('.bat', '')}`, level: 'info' });
  } else {
    out({ text: 'Конфиг не выбран', level: 'warn' });
  }

  if (!bypass.running) {
    out({
      text: 'Нажмите «Старт» в приложении или включите автозапуск обхода в настройках.',
      level: 'info',
    });
  }
}

export function getProcessStatus(
  root: string,
  onLine?: (line: { text: string; level: string }) => void
): Promise<void> {
  return getProcessStatusReport(root, (line) => onLine?.(line));
}

export function runDiagnostics(
  root: string,
  onLine?: (line: { text: string; level: string }) => void
): Promise<void> {
  return runDiagnosticsInApp(root, (line) => onLine?.(line));
}

export function runTests(
  root: string,
  strategyFile: string | null,
  mode: 'current' | 'all',
  onLine?: (line: { text: string; level: string }) => void
): Promise<void> {
  return runTestsInApp(root, strategyFile, mode, (line) => onLine?.(line));
}

export function pickBestStrategyForRoot(
  root: string,
  onLine?: (line: { text: string; level: string }) => void,
  options?: { emitUiEvents?: boolean; shouldCancel?: () => boolean }
): Promise<Awaited<ReturnType<typeof pickBestStrategy>>> {
  return pickBestStrategy(root, (line) => onLine?.(line), options);
}

export function setGameFilter(root: string, mode: SettingsState['gameFilter']): void {
  const flagFile = path.join(root, 'utils', 'game_filter.enabled');
  if (mode === 'disabled') {
    if (fs.existsSync(flagFile)) fs.unlinkSync(flagFile);
    return;
  }
  fs.writeFileSync(flagFile, mode, 'utf8');
}

export function setCheckUpdates(root: string, enabled: boolean): void {
  const flagFile = path.join(root, 'utils', 'check_updates.enabled');
  if (enabled) {
    fs.writeFileSync(flagFile, 'ENABLED', 'utf8');
  } else if (fs.existsSync(flagFile)) {
    fs.unlinkSync(flagFile);
  }
}

export function toggleIpset(root: string): SettingsState['ipset'] {
  const listsDir = path.join(root, 'lists');
  const listFile = path.join(listsDir, 'ipset-all.txt');
  const backupFile = `${listFile}.backup`;
  const status = readIpsetStatus(listsDir);

  if (status === 'loaded') {
    if (fs.existsSync(listFile)) {
      if (fs.existsSync(backupFile)) fs.unlinkSync(backupFile);
      fs.renameSync(listFile, backupFile);
    }
    fs.writeFileSync(listFile, '203.0.113.113/32\n', 'utf8');
  } else {
    if (!fs.existsSync(backupFile)) {
      throw new Error('Не найден список IPSet. Переустановите zapret или восстановите lists/ipset-all.txt');
    }
    if (fs.existsSync(listFile)) fs.unlinkSync(listFile);
    fs.renameSync(backupFile, listFile);
  }

  return readIpsetStatus(listsDir);
}

export async function checkForUpdates(root: string): Promise<{
  current: string | null;
  latest: string | null;
  upToDate: boolean;
}> {
  const current = readInstalledVersion(root);
  const latest = await fetchLatestVersion();
  return {
    current,
    latest,
    upToDate: !latest || !current ? true : current === latest,
  };
}
