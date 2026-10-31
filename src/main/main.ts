import './app-paths';
import { app, BrowserWindow, ipcMain, dialog, shell, Tray, Menu, screen, clipboard, Notification } from 'electron';
import { loadAppIcon } from './icons';
import fs from 'fs';
import path from 'path';
import { runAutonomousBootstrap, type BootstrapState } from './autonomous';
import { scanForInstallations, verifyInstallation } from './scanner';
import { isWindowsAdmin, restartAsAdmin } from './admin';
import { applyLaunchAtStartup, isLaunchAtStartupEnabled, isStartupLaunch, syncLaunchAtStartup } from './autostart';
import {
  addUserListEntries,
  readUserLists,
  saveUserList,
  type UserListKind,
} from './user-lists';
import type { TestResultPayload } from './tests-runner';
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
  setIpsetModeForRoot,
  verifyBypassRunning,
  fullRemoveZapret,
  invalidateStatusCache,
  pickBestStrategyForRoot,
  listStrategies,
  type SettingsState,
} from './zapret';
import {
  listFakeBins,
  replaceActiveFake,
  removeWindowsServices,
  updateHostsFile,
  updateIpsetList,
  type IpsetMode,
} from './zapret-maintenance';
import {
  configureBypassWatchdog,
  setBypassWatchdogExpected,
  startBypassWatchdog,
  stopBypassWatchdog,
} from './bypass-watchdog';
import { tgwsProxy, type TgwsProxyConfig } from './tgws-proxy';
import { checkAccess } from './access-check';

const APP_DISPLAY_NAME = 'Skvoz';
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
  launchAtStartup: boolean;
  autoStartBypass: boolean;
  autoPickBestStrategy: boolean;
  bypassStoppedByUser: boolean;
  bypassAutoRecover: boolean;
  dismissedAppVersion: string | null;
  skipAutoBootstrap: boolean;
  autoUpdateZapret: boolean;
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
  strategy: string | null;
}

let trayMenuState: TrayMenuState = { running: false, canStart: false, strategy: null };
let trayMenuStateAt = 0;

const TRAY_MENU_CACHE_MS = 10_000;
const TRAY_SYNC_MS = 45_000;
const LAUNCH_SYNC_MS = 120_000;
let launchAtStartupSyncedAt = 0;
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
    launchAtStartup: false,
    autoStartBypass: false,
    autoPickBestStrategy: true,
    bypassStoppedByUser: false,
    bypassAutoRecover: true,
    dismissedAppVersion: null,
    skipAutoBootstrap: false,
    settingsRevision: SETTINGS_REVISION,
    autoUpdateZapret: true,
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

function markBypassStoppedByUser(): void {
  if (config.bypassStoppedByUser) return;
  config.bypassStoppedByUser = true;
  saveConfig(config);
}

function clearBypassStoppedByUser(): void {
  if (!config.bypassStoppedByUser) return;
  config.bypassStoppedByUser = false;
  saveConfig(config);
}

function markBypassExpectedRunning(running: boolean): void {
  setBypassWatchdogExpected(running);
}

function initTgwsProxy(): void {
  tgwsProxy.onLog((level, message) => {
    // по строке на каждое подключение — шум; в журнал только важное
    if (level !== 'info') sendToolOutput(`[TG] ${message}`, level);
  });
  tgwsProxy.onStateChange(() => void refreshTrayMenu());
  if (tgwsProxy.getConfig().autostart) {
    tgwsProxy.start().catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      sendToolOutput(`[TG] Автозапуск прокси не удался: ${message}`, 'error');
      notify('Telegram proxy не запустился', message);
    });
  }
}

function initBypassWatchdog(): void {
  configureBypassWatchdog({
    intervalMs: 8_000,
    healthCheckIntervalMs: 30_000,
    maxAttempts: 8,
    isStoppedByUser: () => config.bypassStoppedByUser,
    autoRecoverEnabled: () => config.bypassAutoRecover !== false,
    resolveZapretPath: () => tryResolveZapretPath({ allowScan: false }),
    resolveStrategy: async (root) => {
      const status = await getStatus(root, { light: true });
      const strategy = config.selectedStrategy ?? status.selectedStrategy;
      if (!strategy || !status.strategies.includes(strategy)) return null;
      return strategy;
    },
    restartBypass: async (root, strategy) => {
      await startBypass(root, strategy, (line) => sendToolOutput(line.text, line.level));
    },
    onOutput: (text, level) => sendToolOutput(text, level),
    onRecovered: () => {
      invalidateStatusCache();
      notify('Обход восстановлен', 'winws.exe перезапущен автоматически.');
      mainWindow?.webContents.send('bypass-auto-started');
      void refreshTrayMenu(true);
    },
    onGiveUp: () => {
      invalidateStatusCache();
      mainWindow?.webContents.send('bypass-watchdog-stopped');
      notify('Обход остановился', 'winws.exe упал и не перезапустился. Откройте приложение, чтобы проверить конфиг.');
      void refreshTrayMenu(true);
    },
  });
  startBypassWatchdog();
}

let config = loadConfig();

const WINDOW_BACKGROUND = '#06070c';

/** Кнопки окна рисует Windows поверх нашей полосы заголовка — цвета должны совпадать с --titlebar-bg. */
const TITLEBAR_HEIGHT = 38;

const TITLEBAR_OVERLAY: Electron.TitleBarOverlayOptions = { color: '#0b0c14', symbolColor: '#c9cbe6', height: TITLEBAR_HEIGHT };

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

// ── Автообновление zapret ─────────────────────────────────────────────

const ZAPRET_UPDATE_FIRST_CHECK_MS = 90_000;
const ZAPRET_UPDATE_INTERVAL_MS = 6 * 60 * 60_000;
let zapretUpdateRunning = false;
let zapretUpdateTimer: NodeJS.Timeout | null = null;

/**
 * Ставит свежий релиз Flowseal рядом со старым (списки пользователя переносятся),
 * переключает путь и, если обход работал, поднимает его обратно с тем же конфигом.
 */
async function autoUpdateZapret(): Promise<void> {
  if (!config.autoUpdateZapret || zapretUpdateRunning || autoPickBestStrategyRunning) return;
  const root = getKnownZapretPath();
  if (!root || !isValidZapretPath(root)) return;

  zapretUpdateRunning = true;
  try {
    const info = await checkForUpdates(root);
    if (info.upToDate || !info.latest) return;

    const status = await getStatus(root, { fresh: true });
    if (status.zapretService.exists) {
      // служба Windows указывает на старую папку — менять её молча нельзя
      notify('Доступно обновление zapret', `Версия ${info.latest}. Удалите службу zapret и обновите из приложения.`);
      return;
    }
    const wasRunning = status.bypass.running;
    if (wasRunning && !isWindowsAdmin()) {
      notify('Доступно обновление zapret', `Версия ${info.latest}. Перезапустите приложение от администратора.`);
      return;
    }

    sendToolOutput(`Найден zapret ${info.latest} (сейчас ${info.current ?? '?'}) — обновляю...`, 'info');
    if (wasRunning) {
      markBypassExpectedRunning(false);
      await stopBypass((line) => sendToolOutput(line.text, line.level));
      await delay(900);
    }

    const result = await downloadOfficialZapret(config.installBase, root, sendDownloadProgress);
    config.zapretPath = result.installPath;
    saveConfig(config);
    sanitizeSelectedStrategy(result.installPath);
    invalidateStatusCache();

    if (wasRunning) {
      const fresh = await getStatus(result.installPath, { fresh: true });
      const strategy = config.selectedStrategy ?? fresh.selectedStrategy;
      if (strategy) {
        await startBypass(result.installPath, strategy, (line) => sendToolOutput(line.text, line.level));
        markBypassExpectedRunning(true);
      }
    }

    bootstrapState = {
      stage: 'ready',
      message: `Zapret обновлён до ${result.version}`,
      scan: null,
      selected: null,
      isOfficial: true,
      warnings: [],
      autoFixed: false,
    };
    mainWindow?.webContents.send('bootstrap-complete', bootstrapState);
    sendToolOutput(`[OK] Zapret обновлён до ${result.version}`, 'success');
    notify('Zapret обновлён', `Установлена версия ${result.version}${wasRunning ? ', обход перезапущен' : ''}.`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    sendToolOutput(`Автообновление zapret не удалось: ${message}`, 'warn');
  } finally {
    zapretUpdateRunning = false;
    void refreshTrayMenu(true);
  }
}

function scheduleZapretAutoUpdate(): void {
  if (zapretUpdateTimer) clearInterval(zapretUpdateTimer);
  setTimeout(() => void autoUpdateZapret(), ZAPRET_UPDATE_FIRST_CHECK_MS);
  zapretUpdateTimer = setInterval(() => void autoUpdateZapret(), ZAPRET_UPDATE_INTERVAL_MS);
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
    backgroundColor: WINDOW_BACKGROUND,
    autoHideMenuBar: true,
    titleBarStyle: 'hidden',
    titleBarOverlay: TITLEBAR_OVERLAY,
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

  mainWindow.once('ready-to-show', () => {
    const silentStartup = isStartupLaunch() && config.minimizeToTray;
    if (!silentStartup) {
      mainWindow?.show();
    }
  });

  mainWindow.webContents.once('did-finish-load', () => {
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

// ── Мини-окно у трея ──────────────────────────────────────────────────

const TRAY_WINDOW_SIZE = { width: 330, height: 318 };
let trayWindow: BrowserWindow | null = null;
let trayWindowHiddenAt = 0;

function createTrayWindow(): BrowserWindow {
  const win = new BrowserWindow({
    ...TRAY_WINDOW_SIZE,
    show: false,
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    backgroundColor: WINDOW_BACKGROUND,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
      devTools: !app.isPackaged,
    },
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'tray.html'));
  win.on('blur', () => {
    trayWindowHiddenAt = Date.now();
    win.hide();
  });
  win.on('closed', () => {
    trayWindow = null;
  });
  return win;
}

/** Ставит окно над значком: снизу, сверху или сбоку — смотря где панель задач. */
function positionTrayWindow(win: BrowserWindow): void {
  if (!tray) return;
  const icon = tray.getBounds();
  const display = screen.getDisplayNearestPoint({ x: icon.x, y: icon.y });
  const area = display.workArea;
  const { width, height } = TRAY_WINDOW_SIZE;
  const gap = 8;

  let x = Math.round(icon.x + icon.width / 2 - width / 2);
  let y = icon.y > area.y + area.height / 2 ? icon.y - height - gap : icon.y + icon.height + gap;
  if (icon.width === 0) {
    x = area.x + area.width - width - gap;
    y = area.y + area.height - height - gap;
  }
  x = Math.min(Math.max(x, area.x + gap), area.x + area.width - width - gap);
  y = Math.min(Math.max(y, area.y + gap), area.y + area.height - height - gap);
  win.setPosition(x, y, false);
}

function toggleTrayWindow(): void {
  // клик по значку сначала снимает фокус с окна (blur), не открываем его заново тем же кликом
  if (Date.now() - trayWindowHiddenAt < 250) return;
  if (!trayWindow) trayWindow = createTrayWindow();
  if (trayWindow.isVisible()) {
    trayWindow.hide();
    return;
  }
  positionTrayWindow(trayWindow);
  trayWindow.setBackgroundColor(WINDOW_BACKGROUND);
  trayWindow.show();
  trayWindow.focus();
}

function createTray(): void {
  const icon = loadAppIcon(32);
  if (icon.isEmpty()) return;

  tray = new Tray(icon);
  tray.setToolTip('Skvoz');
  tray.on('click', () => toggleTrayWindow());
  tray.on('double-click', () => focusMainWindow());
  tray.on('right-click', () => {
    void refreshTrayMenu();
  });

  void refreshTrayMenu();
}

function trayTooltip(): string {
  const zapret = trayMenuState.running ? 'обход включён' : 'обход выключен';
  const tg = tgwsProxy.isRunning() ? 'TG proxy работает' : 'TG proxy выключен';
  return `Skvoz — ${zapret}, ${tg}`;
}

async function refreshTrayMenu(force = false): Promise<void> {
  if (!tray) return;

  const cacheFresh = !force && Date.now() - trayMenuStateAt < TRAY_MENU_CACHE_MS;
  if (!cacheFresh) {
    let running = false;
    let canStart = false;
    let strategy: string | null = null;

    try {
      const zapretPath = getKnownZapretPath();
      if (zapretPath) {
        sanitizeSelectedStrategy(zapretPath);
        const status = await getStatus(zapretPath, { light: true });
        running = status.bypass.running;
        strategy = config.selectedStrategy ?? status.selectedStrategy;
        if (!running) {
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

    trayMenuState = { running, canStart, strategy };
    trayMenuStateAt = Date.now();
  }

  tray.setContextMenu(buildTrayMenu());
  tray.setToolTip(trayTooltip());
}

function buildTrayMenu(): Menu {
  const { running, canStart, strategy } = trayMenuState;
  const tgRunning = tgwsProxy.isRunning();
  const tg = tgwsProxy.getConfig();
  const strategyLabel = strategy ? strategy.replace(/\.bat$/i, '') : 'конфиг не выбран';

  return Menu.buildFromTemplate([
    { label: 'Открыть Skvoz', click: () => focusMainWindow() },
    { type: 'separator' },
    { label: `Zapret: ${running ? 'включён' : 'выключен'} · ${strategyLabel}`, enabled: false },
    running
      ? { label: 'Выключить обход', click: () => void traySetBypass(false) }
      : { label: 'Включить обход', enabled: canStart, click: () => void traySetBypass(true) },
    { label: 'Перезапустить обход', enabled: running, click: () => void trayRestartBypass() },
    { type: 'separator' },
    { label: `Telegram proxy: ${tgRunning ? `работает · ${tg.host}:${tg.port}` : 'выключен'}`, enabled: false },
    {
      label: tgRunning ? 'Выключить прокси' : 'Включить прокси',
      click: () => void traySetTgws(!tgRunning),
    },
    {
      label: 'Скопировать ссылку прокси',
      click: () => {
        const link = tgwsProxy.buildProxyLink();
        if (link) clipboard.writeText(link);
      },
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

async function traySetTgws(enable: boolean): Promise<void> {
  try {
    if (enable) await tgwsProxy.start();
    else await tgwsProxy.stop();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    sendToolOutput(`[TG] ${message}`, 'error');
    notify('Telegram proxy не запустился', message);
  }
  void refreshTrayMenu();
}

/** Системное уведомление — только когда окно скрыто, иначе хватает тостов. */
function notify(title: string, body: string): void {
  if (mainWindow?.isVisible() && mainWindow.isFocused()) return;
  if (!Notification.isSupported()) return;
  const notification = new Notification({ title, body, icon: loadAppIcon(64) });
  notification.on('click', () => focusMainWindow());
  notification.show();
}

async function trayRestartBypass(): Promise<void> {
  try {
    const zapretPath = await requireZapretPath();
    const status = await getStatus(zapretPath);
    const strategy = config.selectedStrategy ?? status.selectedStrategy;
    if (!strategy || !status.strategies.includes(strategy)) {
      throw new Error('Стратегия не выбрана');
    }
    sendToolOutput('Перезапуск обхода из трея...', 'info');
    if (status.bypass.running) {
      await stopBypass((line) => sendToolOutput(line.text, line.level));
      await delay(600);
    }
    await startBypass(zapretPath, strategy, (line) => sendToolOutput(line.text, line.level));
    const started = await waitForBypassRunning();
    if (!started) {
      throw new Error('winws.exe не запустился. Запустите приложение от администратора.');
    }
    clearBypassStoppedByUser();
    markBypassExpectedRunning(true);
    sendToolOutput('[OK] Обход перезапущен', 'success');
    mainWindow?.webContents.send('bypass-auto-started');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    sendToolOutput(`Ошибка: ${message}`, 'warn');
  } finally {
    await refreshTrayMenu(true);
  }
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
      clearBypassStoppedByUser();
      markBypassExpectedRunning(true);
    } else {
      markBypassStoppedByUser();
      markBypassExpectedRunning(false);
      sendToolOutput('Остановка обхода из трея...', 'info');
      await stopBypass((line) => sendToolOutput(line.text, line.level));
      const still = await verifyBypassRunning();
      if (still.running) {
        throw new Error(`winws.exe всё ещё работает (PID ${still.pid ?? '?'}). Запустите от администратора.`);
      }
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
  if (config.selectedStrategy && !fs.existsSync(path.join(zapretPath, config.selectedStrategy))) {
    config.selectedStrategy = null;
  }

  if (!config.selectedStrategy) {
    // Только официальные .bat из папки zapret: general.bat, иначе первый по списку.
    try {
      const strategies = listStrategies(zapretPath);
      const preferred =
        strategies.find((s) => s === 'general.bat') ??
        strategies.find((s) => s.toLowerCase() !== 'service.bat') ??
        strategies[0] ??
        null;
      if (preferred) {
        config.selectedStrategy = preferred;
        saveConfig(config);
      }
    } catch {
      /* ignore */
    }
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

async function loadDashboardState(options: { light?: boolean; fresh?: boolean } = {}): Promise<{
  config: AppConfig;
  status: Awaited<ReturnType<typeof getEmptyStatus>>;
}> {
  if (!options.light && Date.now() - launchAtStartupSyncedAt > LAUNCH_SYNC_MS) {
    launchAtStartupSyncedAt = Date.now();
    try {
      const launchAtStartupActual = await isLaunchAtStartupEnabled();
      if (config.launchAtStartup !== launchAtStartupActual) {
        config.launchAtStartup = launchAtStartupActual;
        saveConfig(config);
      }
    } catch {
      /* сверка автозапуска не должна ломать загрузку панели */
    }
  }

  const zapretPath = getKnownZapretPath();
  if (!zapretPath) {
    return { config, status: getEmptyStatus() };
  }

  sanitizeSelectedStrategy(zapretPath);
  const status = await getStatus(zapretPath, { light: options.light, fresh: options.fresh });
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

interface PickJobResult {
  cancelled: boolean;
  strategy: string | null;
  score: number;
  okChecks: number;
  totalChecks: number;
  /** лучший из проверенных до отмены — пользователь может применить его сам */
  partialBest: string | null;
}

interface LastTestResults extends TestResultPayload {
  at: string;
}

function lastTestResultsPath(): string {
  return path.join(app.getPath('userData'), 'last-test.json');
}

function saveLastTestResults(payload: TestResultPayload): void {
  try {
    const record: LastTestResults = { ...payload, at: new Date().toISOString() };
    fs.writeFileSync(lastTestResultsPath(), JSON.stringify(record, null, 2), 'utf8');
  } catch {
    /* результаты — только для удобства */
  }
}

function loadLastTestResults(): LastTestResults | null {
  try {
    return JSON.parse(fs.readFileSync(lastTestResultsPath(), 'utf8')) as LastTestResults;
  } catch {
    return null;
  }
}

async function runPickBestStrategyJob(options: { quick?: boolean } = {}): Promise<PickJobResult> {
  const none: PickJobResult = {
    cancelled: false,
    strategy: null,
    score: 0,
    okChecks: 0,
    totalChecks: 0,
    partialBest: null,
  };
  const zapretPath = await tryResolveZapretPath();
  if (!zapretPath) {
    throw new Error('Zapret не найден');
  }

  sanitizeSelectedStrategy(zapretPath);
  const status = await getStatus(zapretPath);

  if (status.strategies.length === 1) {
    config.selectedStrategy = status.strategies[0];
    saveConfig(config);
    return { ...none, strategy: config.selectedStrategy };
  }

  if (!isWindowsAdmin()) {
    throw new Error('Нужны права администратора для подбора конфига');
  }

  pickBestStrategyCancelRequested = false;
  autoPickBestStrategyAttempted = true;
  autoPickBestStrategyRunning = true;

  try {
    const outcome = await pickBestStrategyForRoot(
      zapretPath,
      (line) => sendToolOutput(line.text, line.level),
      {
        emitUiEvents: true,
        quick: options.quick,
        shouldCancel: () => pickBestStrategyCancelRequested,
      }
    );
    if (outcome.rankings.length > 0) {
      saveLastTestResults({ ...outcome, quick: !!options.quick });
    }

    const best = outcome.best;
    if (outcome.cancelled) {
      await applyDefaultStrategyFallback(zapretPath);
      return { ...none, cancelled: true, partialBest: best?.strategy ?? null };
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
        ...none,
        strategy: best.strategy,
        score: best.score,
        okChecks: best.okChecks,
        totalChecks: best.totalChecks,
      };
    }

    await applyDefaultStrategyFallback(zapretPath);
    return { ...none, strategy: config.selectedStrategy };
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
  if (config.bypassStoppedByUser) return;
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
      clearBypassStoppedByUser();
      markBypassExpectedRunning(true);
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
  if (info.checkFailed || info.upToDate || !info.latest) return false;
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

  ipcMain.handle('set-auto-update-zapret', (_e, enabled: boolean) => {
    config.autoUpdateZapret = !!enabled;
    saveConfig(config);
    if (config.autoUpdateZapret) void autoUpdateZapret();
    return { autoUpdateZapret: config.autoUpdateZapret };
  });

  ipcMain.handle('show-main-window', () => {
    trayWindow?.hide();
    focusMainWindow();
    return { ok: true };
  });

  ipcMain.handle('set-minimize-to-tray', (_e, enabled: boolean) => {
    config.minimizeToTray = !!enabled;
    saveConfig(config);
    return { minimizeToTray: config.minimizeToTray };
  });

  ipcMain.handle('get-dashboard-state', async (_e, options?: { light?: boolean }) =>
    loadDashboardState(options ?? {})
  );

  ipcMain.handle('set-launch-at-startup', async (_e, enabled: boolean) => {
    config.launchAtStartup = !!enabled;
    saveConfig(config);
    try {
      await applyLaunchAtStartup(config.launchAtStartup);
    } catch (error) {
      config.launchAtStartup = await isLaunchAtStartupEnabled();
      saveConfig(config);
      throw error;
    }
    config.launchAtStartup = await isLaunchAtStartupEnabled();
    saveConfig(config);
    return { launchAtStartup: config.launchAtStartup };
  });

  ipcMain.handle('set-auto-start-bypass', async (_e, enabled: boolean) => {
    config.autoStartBypass = !!enabled;
    if (config.autoStartBypass) {
      config.bypassStoppedByUser = false;
    }
    if (config.autoStartBypass && !config.launchAtStartup) {
      config.launchAtStartup = true;
      await applyLaunchAtStartup(true);
    }
    saveConfig(config);
    if (config.autoStartBypass) {
      autoStartBypassAttempted = false;
      postBootstrapCompleted = false;
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

  ipcMain.handle('run-pick-best-strategy', async (_e, options?: { quick?: boolean }) => {
    if (autoPickBestStrategyRunning) {
      throw new Error('Подбор конфига уже выполняется');
    }
    return runPickBestStrategyJob({ quick: !!options?.quick });
  });

  ipcMain.handle('get-last-test-results', () => loadLastTestResults());

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
    if (result.canceled || result.filePaths.length === 0) {
      return { canceled: true as const, config };
    }

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
    postBootstrapCompleted = false;
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

    return { canceled: false as const, config };
  });

  ipcMain.handle('set-strategy', async (_e, strategy: string) => {
    const zapretPath = getKnownZapretPath();
    if (zapretPath) {
      const strategies = listStrategies(zapretPath);
      if (!strategies.includes(strategy)) {
        throw new Error(`Конфиг не найден: ${strategy}`);
      }
    }
    config.selectedStrategy = strategy;
    saveConfig(config);
    return config;
  });

  ipcMain.handle('get-bypass-state', async () => verifyBypassRunning());

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
    await delay(900);
    const running = await verifyBypassRunning();
    if (!running.running) {
      throw new Error('winws.exe не запустился или сразу завершился. Запустите от администратора.');
    }
    sendToolOutput(`[OK] winws.exe запущен (PID ${running.pid ?? '?'})`, 'success');
    clearBypassStoppedByUser();
    markBypassExpectedRunning(true);
    await refreshTrayMenu(true);
    return { ok: true };
  });

  ipcMain.handle('restart-bypass', async () => {
    const zapretPath = await requireZapretPath();
    const status = await getStatus(zapretPath);
    const strategy = config.selectedStrategy ?? status.selectedStrategy;
    if (!strategy) throw new Error('Стратегия не выбрана');
    if (!status.strategies.includes(strategy)) {
      throw new Error(`Стратегия не найдена: ${strategy}`);
    }
    sendToolOutput('Перезапуск обхода...', 'info');
    if (status.bypass.running) {
      await stopBypass((line) => sendToolOutput(line.text, line.level));
      await delay(600);
    }
    await startBypass(zapretPath, strategy, (line) => sendToolOutput(line.text, line.level));
    await delay(900);
    const running = await verifyBypassRunning();
    if (!running.running) {
      throw new Error('winws.exe не запустился после перезапуска. Запустите от администратора.');
    }
    sendToolOutput(`[OK] Обход перезапущен (PID ${running.pid ?? '?'})`, 'success');
    clearBypassStoppedByUser();
    markBypassExpectedRunning(true);
    await refreshTrayMenu(true);
    return { ok: true };
  });

  ipcMain.handle('stop-bypass', async () => {
    markBypassStoppedByUser();
    markBypassExpectedRunning(false);
    await stopBypass((line) => sendToolOutput(line.text, line.level));
    const still = await verifyBypassRunning();
    if (still.running) {
      throw new Error(`winws.exe всё ещё работает (PID ${still.pid ?? '?'}). Запустите от администратора.`);
    }
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
    invalidateStatusCache();
    return { ok: true };
  });

  ipcMain.handle('toggle-ipset', async () => {
    const ipset = toggleIpset(await requireZapretPath());
    invalidateStatusCache();
    return { ok: true, ipset };
  });

  ipcMain.handle('set-ipset-mode', async (_e, mode: IpsetMode) => {
    const ipset = setIpsetModeForRoot(await requireZapretPath(), mode);
    invalidateStatusCache();
    return { ok: true, ipset };
  });

  ipcMain.handle('update-ipset-list', async () => {
    const root = await requireZapretPath();
    await updateIpsetList(root, (line) => sendToolOutput(line.text, line.level));
    invalidateStatusCache();
    return { ok: true };
  });

  ipcMain.handle('update-hosts-file', async () => {
    const result = await updateHostsFile((line) => sendToolOutput(line.text, line.level));
    return { ok: true, ...result };
  });

  ipcMain.handle('list-fake-bins', async () => listFakeBins(await requireZapretPath()));

  ipcMain.handle('replace-active-fake', async (_e, type: 'discord' | 'game', fakeFileName: string) => {
    const name = replaceActiveFake(await requireZapretPath(), type, fakeFileName);
    invalidateStatusCache();
    return { ok: true, name };
  });

  ipcMain.handle('remove-zapret-services', async () => {
    await removeWindowsServices((line) => sendToolOutput(line.text, line.level));
    invalidateStatusCache();
    return { ok: true };
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
    invalidateStatusCache();
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
    autoStartBypassAttempted = false;
    postBootstrapCompleted = false;
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

  // ── tg-ws-proxy IPC handlers ──────────────────────────────────────────

  ipcMain.handle('tgws-get-config', () => tgwsProxy.getConfig());

  ipcMain.handle('tgws-set-config', async (_e, updates: Partial<TgwsProxyConfig>) => {
    await tgwsProxy.setConfig(updates);
    return { ok: true };
  });

  ipcMain.handle('tgws-start', async () => {
    await tgwsProxy.start();
    return { ok: true };
  });

  ipcMain.handle('tgws-stop', async () => {
    await tgwsProxy.stop();
    return { ok: true };
  });

  ipcMain.handle('tgws-status', () => ({
    running: tgwsProxy.isRunning(),
    config: tgwsProxy.getConfig(),
    stats: tgwsProxy.getStats(),
    proxyLink: tgwsProxy.buildProxyLink(),
  }));

  ipcMain.handle('check-access', () =>
    checkAccess({ running: tgwsProxy.isRunning(), config: tgwsProxy.getConfig() })
  );

  ipcMain.handle('tgws-proxy-link', () => tgwsProxy.buildProxyLink());

  ipcMain.handle('open-external', async (_e, url: string) => {
    await shell.openExternal(url);
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

  app.whenReady().then(async () => {
    createTray();
    createWindow();
    scheduleTraySync();

    if (isStartupLaunch()) {
      void runStartupTasks().finally(() => scheduleAppUpdateCheck(60_000));
    }

    void syncLaunchAtStartup(config.launchAtStartup);
    initBypassWatchdog();
    initTgwsProxy();
    scheduleZapretAutoUpdate();

    app.on('before-quit', () => {
      stopBypassWatchdog();
      void tgwsProxy.stop();
    });

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
      else mainWindow?.show();
    });
  });
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
