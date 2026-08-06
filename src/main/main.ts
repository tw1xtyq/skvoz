import { app, BrowserWindow, ipcMain, dialog, shell, Tray, Menu, screen } from 'electron';
import { loadAppIcon } from './icons';
import fs from 'fs';
import path from 'path';
import { runAutonomousBootstrap, type BootstrapState } from './autonomous';
import { scanForInstallations, verifyInstallation } from './scanner';
import { isWindowsAdmin, restartAsAdmin, elevateIfNeeded } from './admin';
import { applyLaunchAtStartup, isStartupLaunch, syncLaunchAtStartup } from './autostart';
import {
  addUserListEntries,
  readUserLists,
  saveUserList,
  type UserListKind,
} from './user-lists';
import { PickBestStrategyCancelledError } from './tests-runner';
import { APP_WINDOW } from './window-size';
import {
  checkAppUpdate,
  downloadAppUpdate,
  getAppReleasePageUrl,
  getCurrentAppVersion,
  scheduleAppUpdateApply,
  type AppUpdateStatus,
  type PendingAppUpdate,
} from './app-updater';
import {
  downloadOfficialZapret,
  fetchLatestRelease,
  getDefaultInstallBase,
  unblockZapretInstall,
  type DownloadProgress,
} from './downloader';
import {
  checkForUpdates,
  getEmptyStatus,
  getStatus,
  getProcessStatus,
  runDiagnostics,
  runTests,
  setCheckUpdates,
  setGameFilter,
  startBypass,
  stopBypass,
  toggleIpset,
  verifyBypassRunning,
  fullRemoveZapret,
  invalidateStatusCache,
  pickBestStrategyForRoot,
  type SettingsState,
} from './zapret';

const APP_DISPLAY_NAME = 'Zapret App';
const APP_USER_MODEL_ID = 'com.protheticglitch.zapret-app';

app.setName(APP_DISPLAY_NAME);
if (process.platform === 'win32') {
  app.setAppUserModelId(APP_USER_MODEL_ID);
  app.commandLine.appendSwitch('disable-features', 'MediaRouter,Translate');
}

if (app.isPackaged) {
  app.commandLine.appendSwitch('disable-dev-shm-usage');
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const CONFIG_FILE = 'config.json';
const SETTINGS_REVISION = 2;

interface AppConfig {
  zapretPath: string;
  installBase: string;
  selectedStrategy: string | null;
  minimizeToTray: boolean;
  bootstrapDone: boolean;
  theme: 'dark' | 'light';
  launchAtStartup: boolean;
  autoStartBypass: boolean;
  autoPickBestStrategy: boolean;
  dismissedAppVersion: string | null;
  skipAutoBootstrap: boolean;
  settingsRevision?: number;
}

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let bootstrapState: BootstrapState | null = null;
let bootstrapRunning = false;
let bootstrapPromise: Promise<void> | null = null;
let autoStartBypassAttempted = false;
let autoStartBypassInFlight: Promise<void> | null = null;
let postBootstrapCompleted = false;
let bootstrapReadySentKey: string | null = null;
let autoPickBestStrategyAttempted = false;
let autoPickBestStrategyRunning = false;
let pickBestStrategyCancelRequested = false;
let lastPathScanAt = 0;

const PATH_SCAN_COOLDOWN_MS = 5 * 60 * 1000;

interface TrayMenuState {
  running: boolean;
  canStart: boolean;
}

let trayMenuState: TrayMenuState = { running: false, canStart: false };
let trayMenuStateAt = 0;

const TRAY_MENU_CACHE_MS = 10_000;
const TRAY_SYNC_MS = 45_000;
let pendingAppUpdate: PendingAppUpdate | null = null;
let ipcRegistered = false;
let startupTasksPromise: Promise<void> | null = null;
let traySyncTimer: ReturnType<typeof setInterval> | null = null;

function configPath(): string {
  return path.join(app.getPath('userData'), CONFIG_FILE);
}

function loadConfig(): AppConfig {
  const defaults: AppConfig = {
    zapretPath: '',
    installBase: getDefaultInstallBase(),
    selectedStrategy: null,
    minimizeToTray: true,
    bootstrapDone: false,
    theme: 'dark',
    launchAtStartup: false,
    autoStartBypass: false,
    autoPickBestStrategy: true,
    dismissedAppVersion: null,
    skipAutoBootstrap: false,
    settingsRevision: SETTINGS_REVISION,
  };

  try {
    const raw = fs.readFileSync(configPath(), 'utf8');
    const merged: AppConfig = { ...defaults, ...JSON.parse(raw) };
    if ((merged.settingsRevision ?? 1) < SETTINGS_REVISION) {
      merged.autoStartBypass = false;
      merged.settingsRevision = SETTINGS_REVISION;
      fs.mkdirSync(path.dirname(configPath()), { recursive: true });
      fs.writeFileSync(configPath(), JSON.stringify(merged, null, 2), 'utf8');
    }
    return merged;
  } catch {
    return defaults;
  }
}

function saveConfig(config: AppConfig): void {
  fs.mkdirSync(path.dirname(configPath()), { recursive: true });
  fs.writeFileSync(configPath(), JSON.stringify(config, null, 2), 'utf8');
}

let config = loadConfig();

function windowBackground(theme: AppConfig['theme'] = config.theme): string {
  return theme === 'light' ? '#dde4ee' : '#030304';
}

function sendBootstrap(state: BootstrapState): void {
  bootstrapState = state;
  mainWindow?.webContents.send('bootstrap-status', state);
}

let downloadProgressLastAt = 0;
let downloadProgressLastKey = '';

function sendDownloadProgress(progress: DownloadProgress): void {
  const force =
    progress.stage === 'done' ||
    progress.stage === 'error' ||
    progress.stage === 'fetch' ||
    progress.stage === 'extract' ||
    progress.stage === 'install';

  const key = `${progress.stage}:${progress.percent}:${progress.message}`;
  const now = Date.now();
  if (!force && key === downloadProgressLastKey && now - downloadProgressLastAt < 160) {
    return;
  }

  downloadProgressLastAt = now;
  downloadProgressLastKey = key;
  mainWindow?.webContents.send('download-progress', progress);
}

function isValidZapretPath(zapretPath: string): boolean {
  return (
    !!zapretPath &&
    fs.existsSync(zapretPath) &&
    fs.existsSync(path.join(zapretPath, 'bin', 'winws.exe'))
  );
}

function emitBootstrapReady(message: string, partial?: Partial<BootstrapState>): void {
  const dedupeKey = `${config.zapretPath}|${message}`;
  if (bootstrapReadySentKey === dedupeKey && !partial?.autoFixed) {
    return;
  }
  bootstrapReadySentKey = dedupeKey;

  bootstrapState = {
    stage: 'ready',
    message,
    scan: null,
    selected: null,
    isOfficial: true,
    warnings: [],
    autoFixed: false,
    ...partial,
  };
  mainWindow?.webContents.send('bootstrap-complete', bootstrapState);
}

async function ensureBootstrap(force = false): Promise<void> {
  if (bootstrapPromise) {
    if (!force) return bootstrapPromise;
    await bootstrapPromise.catch(() => undefined);
    bootstrapPromise = null;
    bootstrapRunning = false;
  }

  const pathValid = isValidZapretPath(config.zapretPath);

  if (!force && config.skipAutoBootstrap && !pathValid) {
    bootstrapState = {
      stage: 'not-found',
      message: 'Zapret не установлен. Скачайте или укажите папку вручную.',
      scan: null,
      selected: null,
      isOfficial: false,
      warnings: [],
      autoFixed: false,
    };
    mainWindow?.webContents.send('bootstrap-complete', bootstrapState);
    return;
  }

  if (!force && config.bootstrapDone && pathValid) {
    emitBootstrapReady(`Zapret найден: ${path.basename(config.zapretPath)}`);
    return;
  }

  bootstrapPromise = (async () => {
    if (!pathValid) {
      const stalePath = config.zapretPath;
      config.bootstrapDone = false;

      const quickScan = await scanForInstallations(stalePath ? [stalePath] : [], config.installBase, {
        deep: false,
      });
      if (quickScan.best && isValidZapretPath(quickScan.best.path)) {
        config.zapretPath = quickScan.best.path;
        config.installBase = path.dirname(quickScan.best.path);
        config.bootstrapDone = true;
        saveConfig(config);
        emitBootstrapReady(`Zapret найден: ${path.basename(quickScan.best.path)}`, {
          isOfficial: quickScan.best.isOfficial,
          warnings: quickScan.best.warnings,
          autoFixed: true,
        });
        return;
      }

      config.zapretPath = '';
      saveConfig(config);
    }

    bootstrapRunning = true;
    try {
      const result = await runAutonomousBootstrap(
        config.zapretPath || undefined,
        config.installBase,
        sendBootstrap,
        sendDownloadProgress
      );

      config.zapretPath = result.path;
      config.bootstrapDone = true;
      config.skipAutoBootstrap = false;
      saveConfig(config);
      bootstrapState = result.state;
      mainWindow?.webContents.send('bootstrap-complete', result.state);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const errorState: BootstrapState = {
        stage: 'error',
        message,
        scan: null,
        selected: null,
        isOfficial: false,
        warnings: [message],
        autoFixed: false,
      };
      bootstrapState = errorState;
      sendBootstrap(errorState);
      mainWindow?.webContents.send('bootstrap-complete', errorState);
    } finally {
      bootstrapRunning = false;
      bootstrapPromise = null;
    }
  })();

  return bootstrapPromise;
}

async function runStartupTasks(): Promise<void> {
  if (startupTasksPromise) return startupTasksPromise;

  startupTasksPromise = (async () => {
    await ensureBootstrap();
    await runPostBootstrapTasks();
  })();

  return startupTasksPromise;
}

function createWindow(): void {
  const windowIcon = loadAppIcon(128);
  const { width, height, minWidth, minHeight } = APP_WINDOW;
  const workArea = screen.getPrimaryDisplay().workArea;
  const x = Math.round(workArea.x + (workArea.width - width) / 2);
  const y = Math.round(workArea.y + (workArea.height - height) / 2);

  mainWindow = new BrowserWindow({
    width,
    height,
    minWidth,
    minHeight,
    x,
    y,
    title: APP_DISPLAY_NAME,
    backgroundColor: windowBackground(),
    autoHideMenuBar: true,
    show: false,
    icon: windowIcon.isEmpty() ? undefined : windowIcon,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
      enableWebSQL: false,
      backgroundThrottling: true,
      devTools: !app.isPackaged,
    },
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  mainWindow.webContents.once('did-finish-load', () => {
    const silentStartup = isStartupLaunch() && config.minimizeToTray;
    if (!silentStartup) {
      mainWindow?.show();
    }

    setImmediate(() => {
      if (isStartupLaunch()) return;

      void runStartupTasks().finally(() => scheduleAppUpdateCheck());
    });
  });

  mainWindow.on('close', (event) => {
    if (config.minimizeToTray && tray) {
      event.preventDefault();
      mainWindow?.hide();
    }
  });

  mainWindow.on('hide', () => {
    mainWindow?.webContents.send('app-window-visibility', { visible: false });
  });

  mainWindow.on('show', () => {
    mainWindow?.webContents.send('app-window-visibility', { visible: true });
    invalidateStatusCache();
    void refreshTrayMenu(true);
  });
}

function scheduleTraySync(): void {
  if (traySyncTimer) {
    clearInterval(traySyncTimer);
  }

  traySyncTimer = setInterval(() => {
    if (mainWindow && !mainWindow.isVisible()) {
      void refreshTrayMenu();
    }
  }, TRAY_SYNC_MS);
}

function createTray(): void {
  const icon = loadAppIcon(32);
  if (icon.isEmpty()) return;

  tray = new Tray(icon);
  tray.setToolTip('Zapret App');
  tray.on('double-click', () => mainWindow?.show());
  tray.on('right-click', () => {
    void refreshTrayMenu();
  });

  void refreshTrayMenu();
}

async function refreshTrayMenu(force = false): Promise<void> {
  if (!tray) return;

  const cacheFresh = !force && Date.now() - trayMenuStateAt < TRAY_MENU_CACHE_MS;
  if (cacheFresh) {
    tray.setContextMenu(buildTrayMenu(trayMenuState.running, trayMenuState.canStart));
    tray.setToolTip(
      trayMenuState.running ? 'Zapret App — обход включён' : 'Zapret App — обход выключен'
    );
    return;
  }

  let running = false;
  let canStart = false;

  try {
    const zapretPath = getKnownZapretPath();
    if (zapretPath) {
      sanitizeSelectedStrategy(zapretPath);
      const status = await getStatus(zapretPath, { light: true });
      running = status.bypass.running;
      if (!running) {
        const strategy = config.selectedStrategy ?? status.selectedStrategy;
        canStart =
          isWindowsAdmin() &&
          status.strategies.length > 0 &&
          !!strategy &&
          status.strategies.includes(strategy);
      }
    }
  } catch {
    /* keep menu usable */
  }

  trayMenuState = { running, canStart };
  trayMenuStateAt = Date.now();
  tray.setContextMenu(buildTrayMenu(running, canStart));
  tray.setToolTip(running ? 'Zapret App — обход включён' : 'Zapret App — обход выключен');
}

function buildTrayMenu(running: boolean, canStart: boolean): Menu {
  return Menu.buildFromTemplate([
    { label: 'Открыть', click: () => mainWindow?.show() },
    { type: 'separator' },
    {
      label: 'Включить zapret',
      enabled: canStart,
      click: () => void traySetBypass(true),
    },
    {
      label: 'Выключить zapret',
      enabled: running,
      click: () => void traySetBypass(false),
    },
    { type: 'separator' },
    {
      label: 'Выход',
      click: () => {
        config.minimizeToTray = false;
        app.quit();
      },
    },
  ]);
}

async function traySetBypass(enable: boolean): Promise<void> {
  try {
    if (enable) {
      const zapretPath = await requireZapretPath();
      const status = await getStatus(zapretPath);
      const strategy = config.selectedStrategy ?? status.selectedStrategy;
      if (!strategy) throw new Error('Стратегия не выбрана');
      if (!status.strategies.includes(strategy)) {
        throw new Error(`Стратегия не найдена: ${strategy}`);
      }
      if (status.bypass.running) return;

      sendToolOutput('Запуск обхода из трея...', 'info');
      await startBypass(zapretPath, strategy, (line) => sendToolOutput(line.text, line.level));

      const started = await waitForBypassRunning();
      if (!started) {
        throw new Error('winws.exe не запустился. Запустите приложение от администратора.');
      }

      const active = await verifyBypassRunning();
      sendToolOutput(`[OK] Обход включён (PID ${active.pid ?? '?'})`, 'success');
    } else {
      sendToolOutput('Остановка обхода из трея...', 'info');
      await stopBypass((line) => sendToolOutput(line.text, line.level));
      sendToolOutput('[OK] Обход выключен', 'success');
    }

    mainWindow?.webContents.send('bypass-auto-started');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    sendToolOutput(`Ошибка: ${message}`, 'warn');
  } finally {
    await refreshTrayMenu(true);
  }
}

function sanitizeSelectedStrategy(zapretPath: string): void {
  if (!config.selectedStrategy) return;
  if (!fs.existsSync(path.join(zapretPath, config.selectedStrategy))) {
    config.selectedStrategy = null;
    saveConfig(config);
  }
}

function getKnownZapretPath(): string | null {
  return isValidZapretPath(config.zapretPath) ? config.zapretPath : null;
}

async function tryResolveZapretPath(options: { allowScan?: boolean } = {}): Promise<string | null> {
  const { allowScan = true } = options;
  const known = getKnownZapretPath();
  if (known) return known;

  if (!allowScan) return null;
  if (Date.now() - lastPathScanAt < PATH_SCAN_COOLDOWN_MS) return null;
  lastPathScanAt = Date.now();

  const hints = config.zapretPath ? [config.zapretPath] : [];
  const scan = await scanForInstallations(hints, config.installBase, { deep: false });
  const candidate = scan.best;

  if (candidate && isValidZapretPath(candidate.path)) {
    config.zapretPath = candidate.path;
    config.installBase = path.dirname(candidate.path);
    config.bootstrapDone = true;
    saveConfig(config);
    await unblockZapretInstall(candidate.path).catch(() => undefined);

    bootstrapState = {
      stage: 'ready',
      message: `Zapret найден: ${path.basename(candidate.path)}`,
      scan,
      selected: candidate,
      isOfficial: candidate.isOfficial,
      warnings: candidate.warnings,
      autoFixed: true,
    };
    mainWindow?.webContents.send('bootstrap-complete', bootstrapState);
    return candidate.path;
  }

  return null;
}

async function loadDashboardState(options: { light?: boolean } = {}): Promise<{
  config: AppConfig;
  status: Awaited<ReturnType<typeof getEmptyStatus>>;
}> {
  const zapretPath = getKnownZapretPath();
  if (!zapretPath) {
    return { config, status: getEmptyStatus() };
  }

  sanitizeSelectedStrategy(zapretPath);
  const status = await getStatus(zapretPath, { light: options.light });
  if (config.selectedStrategy && status.strategies.includes(config.selectedStrategy)) {
    status.selectedStrategy = config.selectedStrategy;
  }
  return { config, status };
}

async function requireZapretPath(): Promise<string> {
  const resolved = await tryResolveZapretPath();
  if (!resolved) {
    throw new Error('Zapret не найден. Нажмите «Скачать с GitHub» или «Найти на ПК».');
  }
  return resolved;
}

function sendToolOutput(text: string, level: string): void {
  mainWindow?.webContents.send('tool-output', { text, level });
}

async function waitForBypassRunning(maxAttempts = 4, pauseMs = 1200): Promise<boolean> {
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    await delay(pauseMs);
    const running = await verifyBypassRunning();
    if (running.running) return true;
  }
  return false;
}

function needsStrategyPick(zapretPath: string, strategies: string[]): boolean {
  if (!config.autoPickBestStrategy) return false;
  if (strategies.length <= 1) return false;
  if (!config.selectedStrategy) return true;
  return !fs.existsSync(path.join(zapretPath, config.selectedStrategy));
}

async function applyDefaultStrategyFallback(zapretPath: string): Promise<string | null> {
  const status = await getStatus(zapretPath);
  const strategy = status.selectedStrategy;
  if (strategy && status.strategies.includes(strategy)) {
    config.selectedStrategy = strategy;
    saveConfig(config);
    return strategy;
  }
  return null;
}

async function isAutoPickPending(): Promise<boolean> {
  if (autoPickBestStrategyAttempted || autoPickBestStrategyRunning || !config.autoPickBestStrategy) {
    return false;
  }

  try {
    const zapretPath = await tryResolveZapretPath();
    if (!zapretPath) return false;

    sanitizeSelectedStrategy(zapretPath);
    const status = await getStatus(zapretPath);
    if (status.bypass.running) return false;
    return needsStrategyPick(zapretPath, status.strategies);
  } catch {
    return false;
  }
}

async function runPickBestStrategyJob(): Promise<{
  cancelled: boolean;
  strategy: string | null;
  score: number;
  okChecks: number;
  totalChecks: number;
}> {
  const zapretPath = await tryResolveZapretPath();
  if (!zapretPath) {
    throw new Error('Zapret не найден');
  }

  sanitizeSelectedStrategy(zapretPath);
  const status = await getStatus(zapretPath);

  if (status.strategies.length === 1) {
    config.selectedStrategy = status.strategies[0];
    saveConfig(config);
    return {
      cancelled: false,
      strategy: config.selectedStrategy,
      score: 0,
      okChecks: 0,
      totalChecks: 0,
    };
  }

  if (!isWindowsAdmin()) {
    throw new Error('Нужны права администратора для подбора конфига');
  }

  pickBestStrategyCancelRequested = false;
  autoPickBestStrategyAttempted = true;
  autoPickBestStrategyRunning = true;

  try {
    const best = await pickBestStrategyForRoot(
      zapretPath,
      (line) => sendToolOutput(line.text, line.level),
      {
        emitUiEvents: true,
        shouldCancel: () => pickBestStrategyCancelRequested,
      }
    );

    if (pickBestStrategyCancelRequested) {
      await applyDefaultStrategyFallback(zapretPath);
      return { cancelled: true, strategy: null, score: 0, okChecks: 0, totalChecks: 0 };
    }

    if (best?.strategy && status.strategies.includes(best.strategy)) {
      config.selectedStrategy = best.strategy;
      saveConfig(config);
      mainWindow?.webContents.send('strategy-auto-picked', {
        strategy: best.strategy,
        score: best.score,
        okChecks: best.okChecks,
        totalChecks: best.totalChecks,
      });
      return {
        cancelled: false,
        strategy: best.strategy,
        score: best.score,
        okChecks: best.okChecks,
        totalChecks: best.totalChecks,
      };
    }

    await applyDefaultStrategyFallback(zapretPath);
    return { cancelled: false, strategy: config.selectedStrategy, score: 0, okChecks: 0, totalChecks: 0 };
  } catch (error) {
    if (error instanceof PickBestStrategyCancelledError || pickBestStrategyCancelRequested) {
      await applyDefaultStrategyFallback(zapretPath);
      return { cancelled: true, strategy: null, score: 0, okChecks: 0, totalChecks: 0 };
    }
    throw error;
  } finally {
    autoPickBestStrategyRunning = false;
    pickBestStrategyCancelRequested = false;
  }
}

async function runPostBootstrapTasks(): Promise<void> {
  if (postBootstrapCompleted) return;
  if (await isAutoPickPending()) return;
  postBootstrapCompleted = true;
  await tryAutoStartBypass();
}

async function tryAutoStartBypass(): Promise<void> {
  if (!config.autoStartBypass) return;
  if (autoStartBypassInFlight) {
    await autoStartBypassInFlight;
    return;
  }
  if (autoStartBypassAttempted) return;

  autoStartBypassInFlight = (async () => {
    if (!isWindowsAdmin()) {
      mainWindow?.webContents.send('auto-start-blocked', { reason: 'admin' });
      return;
    }

    autoStartBypassAttempted = true;

    try {
      const zapretPath = await tryResolveZapretPath();
      if (!zapretPath) return;

      sanitizeSelectedStrategy(zapretPath);
      const status = await getStatus(zapretPath);
      if (status.bypass.running) return;

      const strategy = config.selectedStrategy ?? status.selectedStrategy;
      if (!strategy || !status.strategies.includes(strategy)) return;

      sendToolOutput('Автозапуск обхода...', 'info');
      await startBypass(zapretPath, strategy, (line) => sendToolOutput(line.text, line.level));

      const started = await waitForBypassRunning();
      if (!started) {
        sendToolOutput(
          'Автозапуск не удался: winws.exe не запустился. Проверьте стратегию или перезапустите приложение от администратора.',
          'warn'
        );
        return;
      }

      const running = await verifyBypassRunning();
      sendToolOutput(`[OK] Обход запущен автоматически (PID ${running.pid ?? '?'})`, 'success');
      mainWindow?.webContents.send('bypass-auto-started');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sendToolOutput(`Автозапуск не удался: ${message}`, 'warn');
    } finally {
      await refreshTrayMenu(true);
    }
  })();

  try {
    await autoStartBypassInFlight;
  } finally {
    autoStartBypassInFlight = null;
  }
}

function shouldNotifyAppUpdate(info: AppUpdateStatus): boolean {
  if (info.upToDate || !info.latest) return false;
  if (config.dismissedAppVersion && config.dismissedAppVersion === info.latest) return false;
  return true;
}

function notifyAppUpdateIfNeeded(info: AppUpdateStatus): void {
  if (!shouldNotifyAppUpdate(info)) return;
  mainWindow?.webContents.send('app-update-available', info);
}

function scheduleAppUpdateCheck(delayMs = 3500): void {
  setTimeout(() => {
    void checkAppUpdate()
      .then(notifyAppUpdateIfNeeded)
      .catch(() => undefined);
  }, delayMs);
}

function registerIpc(): void {
  if (ipcRegistered) return;
  ipcRegistered = true;

  ipcMain.handle('get-config', () => config);

  ipcMain.handle('get-dashboard-state', async (_e, options?: { light?: boolean }) =>
    loadDashboardState(options ?? {})
  );

  ipcMain.handle('set-theme', (_e, theme: 'dark' | 'light') => {
    config.theme = theme === 'light' ? 'light' : 'dark';
    saveConfig(config);
    mainWindow?.setBackgroundColor(windowBackground(config.theme));
    return { theme: config.theme };
  });

  ipcMain.handle('set-launch-at-startup', async (_e, enabled: boolean) => {
    config.launchAtStartup = !!enabled;
    saveConfig(config);
    await applyLaunchAtStartup(config.launchAtStartup);
    return { launchAtStartup: config.launchAtStartup };
  });

  ipcMain.handle('set-auto-start-bypass', async (_e, enabled: boolean) => {
    config.autoStartBypass = !!enabled;
    if (config.autoStartBypass && !config.launchAtStartup) {
      config.launchAtStartup = true;
      await applyLaunchAtStartup(true);
    }
    saveConfig(config);
    if (config.autoStartBypass) {
      autoStartBypassAttempted = false;
      void runPostBootstrapTasks();
    }
    return {
      autoStartBypass: config.autoStartBypass,
      launchAtStartup: config.launchAtStartup,
    };
  });

  ipcMain.handle('set-auto-pick-best-strategy', async (_e, enabled: boolean) => {
    config.autoPickBestStrategy = !!enabled;
    saveConfig(config);
    if (config.autoPickBestStrategy) {
      autoPickBestStrategyAttempted = false;
    }
    return { autoPickBestStrategy: config.autoPickBestStrategy };
  });

  ipcMain.handle('get-auto-pick-pending', async () => ({ pending: await isAutoPickPending() }));

  ipcMain.handle('run-pick-best-strategy', async () => {
    if (autoPickBestStrategyRunning) {
      throw new Error('Подбор конфига уже выполняется');
    }
    return runPickBestStrategyJob();
  });

  ipcMain.handle('cancel-pick-best-strategy', () => {
    pickBestStrategyCancelRequested = true;
    return { ok: true };
  });

  ipcMain.handle('complete-post-bootstrap', async () => {
    await runPostBootstrapTasks();
    return { ok: true };
  });
  ipcMain.handle('get-bootstrap-state', () => bootstrapState);

  ipcMain.handle('rescan-zapret', async () => {
    config.skipAutoBootstrap = false;
    lastPathScanAt = 0;
    autoPickBestStrategyAttempted = false;
    autoStartBypassAttempted = false;
    postBootstrapCompleted = false;
    bootstrapReadySentKey = null;
    saveConfig(config);
    await ensureBootstrap(true);
    await runPostBootstrapTasks();
    return bootstrapState;
  });

  ipcMain.handle('scan-installations', async () =>
    scanForInstallations(
      config.zapretPath ? [config.zapretPath] : [],
      config.installBase,
      { deep: true }
    )
  );

  ipcMain.handle('set-zapret-path', async () => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      title: 'Выберите папку zapret-discord-youtube',
      properties: ['openDirectory'],
    });
    if (result.canceled || result.filePaths.length === 0) return config;

    const chosen = result.filePaths[0];
    const nested = fs.existsSync(path.join(chosen, 'bin', 'winws.exe'))
      ? chosen
      : null;

    let installRoot = nested;
    if (!installRoot) {
      for (const entry of fs.readdirSync(chosen, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const candidate = path.join(chosen, entry.name);
        if (fs.existsSync(path.join(candidate, 'bin', 'winws.exe'))) {
          installRoot = candidate;
          break;
        }
      }
    }

    if (!installRoot) {
      throw new Error('В выбранной папке нет bin/winws.exe');
    }

    const verified = verifyInstallation(installRoot, 'manual');
    config.zapretPath = verified.path;
    config.bootstrapDone = true;
    config.skipAutoBootstrap = false;
    autoPickBestStrategyAttempted = false;
    autoStartBypassAttempted = false;
    saveConfig(config);

    bootstrapState = {
      stage: 'ready',
      message: `Выбран zapret ${verified.version ?? ''}`.trim(),
      scan: null,
      selected: null,
      isOfficial: verified.isOfficial,
      warnings: verified.warnings,
      autoFixed: false,
    };
    mainWindow?.webContents.send('bootstrap-complete', bootstrapState);

    void runPostBootstrapTasks();

    return config;
  });

  ipcMain.handle('set-strategy', (_e, strategy: string) => {
    config.selectedStrategy = strategy;
    saveConfig(config);
    return config;
  });

  ipcMain.handle('get-status', async () => {
    const zapretPath = getKnownZapretPath();
    if (!zapretPath) {
      return getEmptyStatus();
    }

    sanitizeSelectedStrategy(zapretPath);
    const status = await getStatus(zapretPath);
    if (config.selectedStrategy && status.strategies.includes(config.selectedStrategy)) {
      status.selectedStrategy = config.selectedStrategy;
    }
    return status;
  });

  ipcMain.handle('start-bypass', async () => {
    const zapretPath = await requireZapretPath();
    const status = await getStatus(zapretPath);
    const strategy = config.selectedStrategy ?? status.selectedStrategy;
    if (!strategy) throw new Error('Стратегия не выбрана');
    if (!status.strategies.includes(strategy)) {
      throw new Error(`Стратегия не найдена: ${strategy}`);
    }
    if (status.bypass.running) {
      throw new Error('Обход уже запущен');
    }
    if (!status.isOfficial) {
      sendToolOutput('Предупреждение: сборка не помечена как официальная', 'warn');
    }
    await startBypass(zapretPath, strategy, (line) => sendToolOutput(line.text, line.level));
    await delay(1500);
    const running = await verifyBypassRunning();
    if (!running.running) {
      throw new Error('winws.exe не запустился или сразу завершился. Запустите от администратора.');
    }
    sendToolOutput(`[OK] winws.exe запущен (PID ${running.pid ?? '?'})`, 'success');
    await refreshTrayMenu(true);
    return { ok: true };
  });

  ipcMain.handle('stop-bypass', async () => {
    await stopBypass((line) => sendToolOutput(line.text, line.level));
    await refreshTrayMenu(true);
    return { ok: true };
  });

  ipcMain.handle('full-remove-zapret', async () => {
    const currentPath = isValidZapretPath(config.zapretPath) ? config.zapretPath : null;
    const result = await fullRemoveZapret(
      currentPath,
      config.installBase,
      (line) => sendToolOutput(line.text, line.level)
    );

    config.zapretPath = '';
    config.selectedStrategy = null;
    config.bootstrapDone = false;
    config.skipAutoBootstrap = true;
    saveConfig(config);
    invalidateStatusCache();
    lastPathScanAt = 0;
    trayMenuStateAt = 0;

    bootstrapPromise = null;
    bootstrapRunning = false;
    autoStartBypassAttempted = false;
    autoPickBestStrategyAttempted = false;

    bootstrapState = {
      stage: 'not-found',
      message: 'Zapret удалён. Скачайте или укажите папку вручную.',
      scan: null,
      selected: null,
      isOfficial: false,
      warnings: [],
      autoFixed: false,
    };
    mainWindow?.webContents.send('bootstrap-complete', bootstrapState);

    return { ok: true, removedPaths: result.removedPaths };
  });

  ipcMain.handle('set-game-filter', async (_e, mode: SettingsState['gameFilter']) => {
    setGameFilter(await requireZapretPath(), mode);
    return { ok: true };
  });

  ipcMain.handle('toggle-ipset', async () => {
    const ipset = toggleIpset(await requireZapretPath());
    return { ok: true, ipset };
  });

  ipcMain.handle('get-user-lists', async () => readUserLists(await requireZapretPath()));

  ipcMain.handle('save-user-list', async (_e, kind: UserListKind, content: string) => {
    const lists = saveUserList(await requireZapretPath(), kind, content);
    return { ok: true, lists };
  });

  ipcMain.handle('add-user-list-entries', async (_e, kind: UserListKind, entries: string[]) => {
    const result = addUserListEntries(await requireZapretPath(), kind, entries);
    return { ok: true, ...result };
  });

  ipcMain.handle('set-check-updates', async (_e, enabled: boolean) => {
    setCheckUpdates(await requireZapretPath(), enabled);
    return { ok: true };
  });

  ipcMain.handle('run-diagnostics', async () => {
    const root = await requireZapretPath();
    await runDiagnostics(root, (line) => sendToolOutput(line.text, line.level));
    return { ok: true };
  });

  ipcMain.handle('run-tests', async (_e, mode: 'current' | 'all' = 'current') => {
    if (mode === 'all') {
      if (autoPickBestStrategyRunning) {
        throw new Error('Подбор конфига уже выполняется');
      }
      await runPickBestStrategyJob();
      return { ok: true };
    }

    const root = await requireZapretPath();
    const status = await getStatus(root);
    const strategy = config.selectedStrategy ?? status.selectedStrategy;
    await runTests(root, strategy, mode, (line) => sendToolOutput(line.text, line.level));
    return { ok: true };
  });

  ipcMain.handle('get-process-status', async () => {
    await getProcessStatus(await requireZapretPath(), (line) => sendToolOutput(line.text, line.level));
    return { ok: true };
  });

  ipcMain.handle('check-updates', async () => checkForUpdates(await requireZapretPath()));

  ipcMain.handle('check-app-update', async () => checkAppUpdate());

  ipcMain.handle('get-app-version', () => getCurrentAppVersion());

  ipcMain.handle('download-app-update', async () => {
    pendingAppUpdate = await downloadAppUpdate(sendDownloadProgress);
    return pendingAppUpdate;
  });

  ipcMain.handle('apply-app-update', async () => {
    if (!pendingAppUpdate) {
      throw new Error('Сначала скачайте обновление');
    }
    const update = pendingAppUpdate;
    pendingAppUpdate = null;
    scheduleAppUpdateApply(update);
    setTimeout(() => app.quit(), 900);
    return { ok: true, version: update.version };
  });

  ipcMain.handle('dismiss-app-update', (_e, version: string) => {
    config.dismissedAppVersion = version || null;
    saveConfig(config);
    return { dismissedAppVersion: config.dismissedAppVersion };
  });

  ipcMain.handle('open-app-release-page', () => {
    shell.openExternal(getAppReleasePageUrl());
    return { ok: true };
  });

  ipcMain.handle('get-release-info', () => fetchLatestRelease());

  ipcMain.handle('download-zapret', async () => {
    try {
      const running = await verifyBypassRunning();
      if (running.running) {
        sendDownloadProgress({
          stage: 'install',
          percent: 0,
          message: 'Остановка обхода перед установкой...',
        });
        await stopBypass();
        await delay(900);
      }
    } catch {
      /* continue install */
    }

    const result = await downloadOfficialZapret(
      config.installBase,
      isValidZapretPath(config.zapretPath) ? config.zapretPath : null,
      sendDownloadProgress
    );

    config.zapretPath = result.installPath;
    config.bootstrapDone = true;
    config.skipAutoBootstrap = false;
    saveConfig(config);

    bootstrapState = {
      stage: 'ready',
      message: `Установлен zapret ${result.version}`,
      scan: null,
      selected: null,
      isOfficial: true,
      warnings: [],
      autoFixed: true,
    };
    mainWindow?.webContents.send('bootstrap-complete', bootstrapState);

    autoPickBestStrategyAttempted = false;
    void runPostBootstrapTasks();

    return result;
  });

  ipcMain.handle('open-download-page', () => {
    shell.openExternal('https://github.com/Flowseal/zapret-discord-youtube/releases/latest');
    return { ok: true };
  });

  ipcMain.handle('open-app-repo', () => {
    shell.openExternal(getAppReleasePageUrl());
    return { ok: true };
  });

  ipcMain.handle('is-admin', () => isWindowsAdmin());
  ipcMain.handle('restart-as-admin', () => {
    const started = restartAsAdmin(() => {
      app.releaseSingleInstanceLock();
    });
    if (!started) {
      throw new Error(
        'Не удалось запросить права администратора. Подтвердите запрос UAC или закройте приложение и запустите его через правую кнопку мыши → «Запуск от имени администратора».'
      );
    }
    return { ok: true };
  });
}

function focusMainWindow(): void {
  const show = (): void => {
    if (!mainWindow) {
      createWindow();
      return;
    }

    if (mainWindow.isMinimized()) {
      mainWindow.restore();
    }
    mainWindow.show();
    mainWindow.focus();
  };

  if (app.isReady()) {
    show();
    return;
  }

  void app.whenReady().then(show);
}

const gotSingleInstanceLock = app.requestSingleInstanceLock();

if (!gotSingleInstanceLock) {
  app.quit();
} else {
  registerIpc();

  app.on('second-instance', () => {
    focusMainWindow();
  });

  if (elevateIfNeeded()) {
    app.releaseSingleInstanceLock();
    setTimeout(() => app.exit(0), 400);
  } else {
    app.whenReady().then(async () => {
      createTray();
      createWindow();
      scheduleTraySync();

      if (isStartupLaunch()) {
        void runStartupTasks().finally(() => scheduleAppUpdateCheck(60_000));
      }

      void syncLaunchAtStartup(config.launchAtStartup);

      app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
        else mainWindow?.show();
      });
    });
  }
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
