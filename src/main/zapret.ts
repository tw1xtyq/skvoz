import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import {
  fetchLatestVersion,
  readInstalledVersion,
} from './downloader';
import { scanForInstallations, verifyInstallation } from './scanner';
import { parseScState, runDiagnosticsInApp } from './diagnostics';
import { runTestsInApp, pickBestStrategy } from './tests-runner';
import {
  killWinwsProcesses,
} from './bypass-prep';
import {
  parseGameFilterMode,
  startBypassHidden,
} from './service-actions';
import { fullRemoveZapretFromPc } from './uninstall';
import { runHidden } from './exec';
import { hasIpsetBackup, readIpsetMode, setIpsetMode, type IpsetMode } from './zapret-maintenance';

/** Подпись стратегии для выпадающего списка: убираем расширение .bat */
export function formatStrategyLabel(fileName: string): string {
  return fileName.replace(/\.bat$/i, '');
}

/** Дефолтная стратегия — только официальные: general.bat, иначе первая по списку. */
export function resolvePreferredStrategy(zapretRoot: string): string | null {
  const strategies = listStrategies(zapretRoot);
  if (strategies.includes('general.bat')) return 'general.bat';
  return strategies[0] ?? null;
}

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
  ipsetBackupAvailable: boolean;
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
    settings: { gameFilter: 'disabled', ipset: 'none', checkUpdates: false, ipsetBackupAvailable: false },
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
    // на русской Windows вместо STATE там «Состояние»: служба выглядела отсутствующей
    const parsed = parseScState(await runCmd('sc', ['query', name]));
    if (parsed === 'missing') {
      return { exists: false, running: false, state: 'NOT_FOUND', strategy: null };
    }
    return { exists: true, running: parsed === 'running', state: parsed.toUpperCase(), strategy: null };
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
  return parseGameFilterMode(fs.readFileSync(flagFile, 'utf8'));
}

function readIpsetStatus(listsDir: string): SettingsState['ipset'] {
  return readIpsetMode(listsDir);
}

function readCheckUpdates(utilsDir: string): boolean {
  return fs.existsSync(path.join(utilsDir, 'check_updates.enabled'));
}

let cachedLatestVersion: { value: string | null; at: number } | null = null;
let statusCache: { root: string; status: ZapretStatus; at: number } | null = null;
let verificationCache: { root: string; isOfficial: boolean; warnings: string[]; at: number } | null = null;

const STATUS_CACHE_MS = 10_000;
const STATUS_CACHE_LIGHT_MS = 20_000;
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

  const [bypass, zapretServiceRaw, windivertService] = options.light
    ? [
        await isWinwsRunning(),
        { exists: false, running: false, state: 'NOT_FOUND', strategy: null },
        { exists: false, running: false, state: 'NOT_FOUND', strategy: null },
      ]
    : await Promise.all([isWinwsRunning(), queryService('zapret'), queryService('WinDivert')]);

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
    ipsetBackupAvailable: hasIpsetBackup(paths.lists),
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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function stopBypass(onLine?: (line: { text: string; level: string }) => void): Promise<void> {
  onLine?.({ text: 'Остановка winws.exe...', level: 'info' });
  try {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await killWinwsProcesses();
      await delay(450);

      const state = await verifyBypassRunning();
      if (!state.running) {
        onLine?.({ text: '[OK] Обход остановлен', level: 'success' });
        return;
      }

      if (attempt < 3) {
        onLine?.({
          text: `winws.exe ещё активен (PID ${state.pid ?? '?'}), повтор остановки...`,
          level: 'warn',
        });
      }
    }

    const still = await verifyBypassRunning();
    if (still.running) {
      throw new Error(
        `winws.exe не остановился (PID ${still.pid ?? '?'}). Запустите приложение от администратора.`
      );
    }
    onLine?.({ text: '[OK] Обход остановлен', level: 'success' });
  } catch (error) {
    if (error instanceof Error && error.message.includes('не остановился')) {
      onLine?.({ text: error.message, level: 'error' });
      throw error;
    }
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
  out: (line: { text: string; level: 'info' | 'success' | 'warn' | 'error' }) => void,
  activeStrategy?: string | null
): Promise<void> {
  const status = await getStatus(root, { fresh: true });
  const { bypass, zapretService, windivertService, settings } = status;
  // getStatus знает только службу и general.bat, а выбранный конфиг хранится в настройках
  const selectedStrategy = activeStrategy ?? status.selectedStrategy;

  if (bypass.running) {
    out({
      text: `Обход запущен: winws.exe${bypass.pid ? ` (PID ${bypass.pid})` : ''}`,
      level: 'success',
    });
  } else {
    out({ text: 'Обход остановлен: winws.exe не запущен', level: 'info' });
  }

  if (selectedStrategy) {
    out({ text: `Конфиг: ${selectedStrategy.replace('.bat', '')}`, level: 'info' });
  } else {
    out({ text: 'Конфиг не выбран', level: 'warn' });
  }

  const ipsetLabels: Record<SettingsState['ipset'], string> = {
    loaded: 'loaded',
    none: 'none',
    any: 'any',
  };
  const gameLabels: Record<SettingsState['gameFilter'], string> = {
    disabled: 'disabled',
    all: 'enabled (TCP and UDP)',
    tcp: 'enabled (TCP)',
    udp: 'enabled (UDP)',
  };

  out({ text: `Game Filter: ${gameLabels[settings.gameFilter]}`, level: 'info' });
  out({ text: `IPSet Filter: ${ipsetLabels[settings.ipset]}`, level: 'info' });
  out({
    text: `Автообновления: ${settings.checkUpdates ? 'включены' : 'выключены'}`,
    level: 'info',
  });

  if (zapretService.exists) {
    out({
      text: `Служба zapret: ${zapretService.running ? 'запущена' : zapretService.state}${
        zapretService.strategy ? ` (${zapretService.strategy})` : ''
      }`,
      level: zapretService.running ? 'success' : 'warn',
    });
  } else {
    out({ text: 'Служба zapret: не установлена', level: 'info' });
  }

  if (windivertService.exists) {
    out({
      text: `Служба WinDivert: ${windivertService.running ? 'запущена' : windivertService.state}`,
      level: windivertService.running ? 'success' : 'warn',
    });
  } else {
    out({ text: 'Служба WinDivert: не установлена', level: 'info' });
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
  onLine?: (line: { text: string; level: string }) => void,
  activeStrategy?: string | null
): Promise<void> {
  return getProcessStatusReport(root, (line) => onLine?.(line), activeStrategy);
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
  options?: { emitUiEvents?: boolean; shouldCancel?: () => boolean; quick?: boolean }
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

export function setIpsetModeForRoot(root: string, mode: IpsetMode): SettingsState['ipset'] {
  invalidateStatusCache();
  return setIpsetMode(root, mode);
}

export function toggleIpset(root: string): SettingsState['ipset'] {
  const listsDir = path.join(root, 'lists');
  const current = readIpsetMode(listsDir);
  const next: IpsetMode = current === 'loaded' ? 'none' : current === 'none' ? 'any' : 'loaded';
  return setIpsetMode(root, next);
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
