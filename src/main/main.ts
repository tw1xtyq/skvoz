import './app-paths';
import {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  shell,
  Tray,
  Menu,
  screen,
  clipboard,
  Notification,
  net,
  powerMonitor,
  type NativeImage,
} from 'electron';
import os from 'os';
import { loadAppIcon } from './icons';
import fs from 'fs';
import path from 'path';
import { consumeFreshInstallMarker, runAutonomousBootstrap, type BootstrapState } from './autonomous';
import { scanForInstallations, verifyInstallation } from './scanner';
import { isWindowsAdmin, restartAsAdmin } from './admin';
import { applyLaunchAtStartup, isLaunchAtStartupEnabled, isStartupLaunch, STARTUP_LAUNCH_ARG, syncLaunchAtStartup, UPDATED_LAUNCH_ARG } from './autostart';
import {
  addUserListEntries,
  readUserLists,
  saveUserList,
  type UserListKind,
} from './user-lists';
import {
  loadTargets,
  rankingPct,
  type PickBestStrategyOutcome,
  type StrategyRanking,
  type TestResultPayload,
} from './tests-runner';
import { normalizeProbeSite, pickProbeUrls, probeBypassTargets } from './bypass-health';
import { BypassEventLog, type BypassEventKind } from './bypass-events';
import { BackgroundRerank, hasDisplayRequests } from './background-rerank';
import { buildDiagnosticReport, type LogLine } from './diagnostic-report';
import { loadLogProblems, saveLogProblems } from './tool-log';
import { capture, detectNetwork, interfacesFingerprint, UNKNOWN_NETWORK, type NetworkIdentity } from './network-id';
import { StrategyMemory } from './strategy-memory';
import { withStatusDot, type Rgb } from './tray-badge';
import { APP_WINDOW } from './window-size';
import { loadConfig, saveConfig, type AppConfig } from './config';
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
  installZapret,
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
import { BypassWatchdog, strategyLabel, type WatchdogHealth } from './bypass-watchdog';
import { tgwsProxy, type TgwsProxyConfig } from './tgws-proxy';
import { RepeatFilter } from './tgws/server';
import { amneziaVpn } from './amneziawg';
import { createWarpVpn, WARP_ENDPOINTS, type WarpGenerateOptions } from './warp-generator';
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
  strategies: string[];
}

let trayMenuState: TrayMenuState = { running: false, canStart: false, strategy: null, strategies: [] };
let trayMenuStateAt = 0;

const TRAY_MENU_CACHE_MS = 10_000;
const TRAY_SYNC_MS = 45_000;
const LAUNCH_SYNC_MS = 120_000;
let launchAtStartupSyncedAt = 0;
let pendingAppUpdate: PendingAppUpdate | null = null;
let ipcRegistered = false;
let startupTasksPromise: Promise<void> | null = null;
let traySyncTimer: ReturnType<typeof setInterval> | null = null;

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
  bypassWatchdog.setExpected(running);
  if (running) logBypassEvent('started', 'Обход запущен', config.selectedStrategy);
  else logBypassEvent('stopped', 'Обход остановлен');
  updateTrayIcon();
}

function initTgwsProxy(): void {
  tgwsProxy.onLog((level, message) => {
    // по строке на каждое подключение — шум; в журнал только важное
    if (level === 'info') return;
    const text = message.replace(/^\[[^\]]+\]\s*/, '');
    // Telegram повторяет подключения раз в секунду: без фильтра они вытесняли из отчёта всё остальное
    const { show, skipped } = tgLogRepeats.accept(text);
    if (show) sendToolOutput(`[TG] ${text}${skipped > 0 ? ` (повторов за минуту: ${skipped})` : ''}`, level);
  });
  tgwsProxy.onStateChange(() => void refreshTrayMenu());
  const tgConfig = tgwsProxy.getConfig();
  // После обновления поднимаем прокси, если он работал до перезапуска
  const resumeAfterUpdate = process.argv.includes(UPDATED_LAUNCH_ARG) && tgConfig.enabled;
  if (tgConfig.enabled) void tgwsProxy.setConfig({ enabled: false }).catch(() => undefined);
  if (tgConfig.autostart || resumeAfterUpdate) {
    tgwsProxy.startWithRetry().catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      sendToolOutput(`[TG] Автозапуск прокси не удался: ${message}`, 'error');
      notify('Telegram proxy не запустился', message);
    });
  }
}

function initVpn(): void {
  amneziaVpn.onLog((level, message) => sendToolOutput(message, level));
  amneziaVpn.onStateChange(() => void refreshTrayMenu());
  const settings = amneziaVpn.getSettings();
  // После обновления поднимаем VPN, если он работал до перезапуска
  const resumeAfterUpdate = process.argv.includes(UPDATED_LAUNCH_ARG) && settings.enabled;
  if (settings.enabled) amneziaVpn.setSettings({ enabled: false });
  void amneziaVpn.queryService().then((state) => {
    if (state === 'RUNNING' || !amneziaVpn.isConfigured()) return;
    if (!settings.autostart && !resumeAfterUpdate) return;
    amneziaVpn.connectWithRetry().catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      sendToolOutput(`[VPN] Автозапуск не удался: ${message}`, 'error');
      notify('VPN не подключился', message);
    });
  });
}

const WARP_API_DOMAIN = 'cloudflareclient.com';

/**
 * РКН блокирует регистрацию WARP, а обход zapret её пропускает. Если обход выключен —
 * включаем его на время регистрации и возвращаем функцию, которая выключит его обратно.
 * Флаги сторожа не трогаем: для него это не запуск пользователем.
 */
async function openWarpRoute(): Promise<(() => Promise<void>) | null> {
  const root = await tryResolveZapretPath({ allowScan: false });
  if (!root) return null;
  // Кэш статуса может отставать — иначе запустим второй winws поверх работающего
  invalidateStatusCache();
  const status = await getStatus(root);
  const strategy = config.selectedStrategy ?? status.selectedStrategy;
  if (status.bypass.running || !strategy || !status.strategies.includes(strategy)) return null;

  // В list-general.txt от Flowseal домен уже есть; на случай другой сборки добавляем в свой список
  const generalList = path.join(root, 'lists', 'list-general.txt');
  const listed = fs.existsSync(generalList)
    && fs.readFileSync(generalList, 'utf8').split(/\r?\n/).some((line) => line.trim().replace(/^\^/, '') === WARP_API_DOMAIN);
  if (!listed) addUserListEntries(root, 'general', [WARP_API_DOMAIN]);

  const log = (line: { text: string; level: string }): void => sendToolOutput(line.text, line.level);
  await startBypass(root, strategy, log);
  await delay(1500);
  invalidateStatusCache();
  if (!(await verifyBypassRunning()).running) return null;
  void refreshTrayMenu(true);
  return async () => {
    await stopBypass(log);
    invalidateStatusCache();
    await refreshTrayMenu(true);
  };
}

// ── Сторож обхода, память конфигов по сетям, фоновая перепроверка ─────

const BAD_STRATEGY_TTL_MS = 6 * 60 * 60_000;
const RERANK_MAX_AGE_MS = 3 * 24 * 60 * 60_000;
const NETWORK_POLL_MS = 20_000;
const TOOL_LOG_LIMIT = 400;

const strategyMemory = new StrategyMemory(path.join(app.getPath('userData'), 'strategy-memory.json'));
const bypassEvents = new BypassEventLog(path.join(app.getPath('userData'), 'bypass-events.json'));
const toolErrorsFile = path.join(app.getPath('userData'), 'tool-errors.json');
const toolLog: LogLine[] = loadLogProblems(toolErrorsFile);
const tgLogRepeats = new RepeatFilter(60_000);
let currentNetwork: NetworkIdentity = UNKNOWN_NETWORK;
let networkFingerprint = '';
let networkTimer: ReturnType<typeof setInterval> | null = null;

const HEALTH_LABEL: Record<WatchdogHealth, string> = {
  off: 'выключен',
  checking: 'проверяется',
  ok: 'сайты открываются',
  degraded: 'не все сайты открылись',
  recovering: 'восстанавливается',
  down: 'не работает',
};

const TRAY_DOT_COLORS: Partial<Record<WatchdogHealth, Rgb>> = {
  ok: [52, 199, 89],
  degraded: [255, 184, 0],
  recovering: [255, 184, 0],
  down: [255, 92, 82],
};

const trayIconCache = new Map<string, NativeImage>();

function emitBypassActivity(): void {
  mainWindow?.webContents.send('bypass-activity-changed');
  if (trayWindow && !trayWindow.isDestroyed()) trayWindow.webContents.send('bypass-activity-changed');
}

function logBypassEvent(kind: BypassEventKind, text: string, strategy?: string | null): void {
  bypassEvents.add(kind, text, strategy);
  emitBypassActivity();
}

function setSelectedStrategy(strategy: string | null): void {
  config.selectedStrategy = strategy;
  saveConfig(config);
  strategyMemory.rememberSelected(currentNetwork.id, currentNetwork.label, strategy);
}

/** Рейтинг этой сети; если его ещё не снимали — последний подбор, если он с той же папки zapret */
function currentRankings(root: string): StrategyRanking[] {
  const own = strategyMemory.getRankings(currentNetwork.id, root);
  if (own.length > 0) return own;
  const last = loadLastTestResults();
  return last && (!last.root || last.root === root) ? last.rankings : [];
}

function saveRankings(root: string, outcome: PickBestStrategyOutcome, quick: boolean): void {
  if (outcome.rankings.length === 0) return;
  // прерванный подбор не показываем как «последние результаты», но в память сети берём
  if (!outcome.cancelled) saveLastTestResults({ ...outcome, quick }, root);
  strategyMemory.saveRankings(currentNetwork.id, currentNetwork.label, root, outcome.rankings, !quick && !outcome.cancelled);
}

function resolveProbeUrls(root: string, strategy: string): string[] {
  const failed = currentRankings(root).find((r) => r.strategy === strategy)?.failed ?? [];
  return pickProbeUrls(loadTargets(root), failed, config.probeSites);
}

function isBypassAutomationBusy(): boolean {
  return autoPickBestStrategyRunning || backgroundRerank.isRunning || zapretUpdateRunning;
}

let lastProbeFailedHosts: string[] = [];

const bypassWatchdog = new BypassWatchdog({
  intervalMs: 8_000,
  healthCheckIntervalMs: 30_000,
  maxAttempts: 8,
  restartsBeforeSwitch: 2,
  maxFallbacks: 4,
  isStoppedByUser: () => config.bypassStoppedByUser,
  autoRecoverEnabled: () => config.bypassAutoRecover !== false,
  autoSwitchEnabled: () => config.bypassAutoSwitch !== false,
  isBusy: isBypassAutomationBusy,
  isOnline: () => net.isOnline(),
  verifyRunning: verifyBypassRunning,
  resolveZapretPath: () => tryResolveZapretPath({ allowScan: false }),
  resolveStrategy: async (root) => {
    const status = await getStatus(root, { light: true });
    const strategy = config.selectedStrategy ?? status.selectedStrategy;
    if (!strategy || !status.strategies.includes(strategy)) return null;
    return strategy;
  },
  probe: (root, strategy) =>
    probeBypassTargets(resolveProbeUrls(root, strategy), {
      onFailed: (hosts) => {
        lastProbeFailedHosts = hosts;
      },
    }),
  describeProbeFailure: () => (lastProbeFailedHosts.length > 0 ? `Не открылись: ${lastProbeFailedHosts.join(', ')}` : ''),
  restartBypass: async (root, strategy) => {
    await startBypass(root, strategy, (line) => sendToolOutput(line.text, line.level));
  },
  nextFallbackStrategy: async (root, tried) => {
    const status = await getStatus(root, { light: true });
    const next = currentRankings(root).find(
      (r) =>
        status.strategies.includes(r.strategy) &&
        !tried.includes(r.strategy) &&
        !strategyMemory.isBad(currentNetwork.id, root, r.strategy) &&
        rankingPct(r) > 0
    );
    return next?.strategy ?? null;
  },
  markStrategyBad: (root, strategy) =>
    strategyMemory.markBad(currentNetwork.id, currentNetwork.label, root, strategy, BAD_STRATEGY_TTL_MS),
  quickPickStrategy: async (root) => {
    autoPickBestStrategyRunning = true;
    try {
      const outcome = await pickBestStrategyForRoot(root, (line) => sendToolOutput(line.text, line.level), {
        emitUiEvents: false,
        quick: true,
        shouldCancel: () => config.bypassStoppedByUser || config.bypassAutoRecover === false,
      });
      saveRankings(root, outcome, true);
      const best = outcome.best;
      return best && rankingPct(best) > 0 ? best.strategy : null;
    } finally {
      autoPickBestStrategyRunning = false;
    }
  },
  onStrategySwitched: (strategy, previous) => {
    setSelectedStrategy(strategy);
    invalidateStatusCache();
    notify(
      'Конфиг переключён',
      `${strategyLabel(previous)} перестал работать — обход переключён на ${strategyLabel(strategy)}.`
    );
    mainWindow?.webContents.send('bypass-auto-started');
    void refreshTrayMenu(true);
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
    notify('Обход остановился', 'Рабочий конфиг не найден. Откройте приложение, чтобы проверить настройки.');
    void refreshTrayMenu(true);
  },
  onEvent: (event) => logBypassEvent(event.kind, event.text, event.strategy),
  onHealth: () => {
    rebuildTrayMenu();
    emitBypassActivity();
  },
});

const backgroundRerank = new BackgroundRerank({
  isEnabled: () => config.backgroundRerank !== false,
  // перепроверяем только работающий обход: если пользователь его выключил, winws не трогаем
  canRun: () =>
    isWindowsAdmin() &&
    !autoPickBestStrategyRunning &&
    !zapretUpdateRunning &&
    !bypassWatchdog.isRecovering &&
    !['off', 'down'].includes(bypassWatchdog.currentHealth) &&
    !powerMonitor.isOnBatteryPower(),
  getIdleSeconds: () => powerMonitor.getSystemIdleTime(),
  isUserWatching: async () => {
    const output = await capture('powercfg.exe', ['/requests']);
    // не смогли спросить Windows — лучше пропустить перепроверку, чем оборвать фильм
    return output === null || hasDisplayRequests(output);
  },
  needsRerank: async () => {
    const root = getKnownZapretPath();
    if (!root) return false;
    const status = await getStatus(root, { light: true });
    if (status.strategies.length < 2) return false;
    const rankedAt = strategyMemory.rankedAt(currentNetwork.id, root);
    return rankedAt === null || Date.now() - rankedAt > RERANK_MAX_AGE_MS;
  },
  run: (shouldCancel) => runBackgroundRerank(shouldCancel),
});

async function runBackgroundRerank(shouldCancel: () => boolean): Promise<'done' | 'cancelled' | 'failed'> {
  const root = await tryResolveZapretPath({ allowScan: false });
  if (!root) return 'failed';
  const previous = config.selectedStrategy;
  const log = (line: { text: string; level: string }): void => sendToolOutput(`[Фон] ${line.text}`, line.level);

  logBypassEvent('rerank', 'Перепроверка конфигов в простое');
  let outcome: PickBestStrategyOutcome | null = null;
  // пользователь мог выключить обход или саму перепроверку, пока она шла
  const stoppedByUser = (): boolean => config.bypassStoppedByUser || config.backgroundRerank === false;
  autoPickBestStrategyRunning = true;
  try {
    outcome = await pickBestStrategyForRoot(root, log, {
      emitUiEvents: false,
      shouldCancel: () => shouldCancel() || stoppedByUser(),
    });
    saveRankings(root, outcome, false);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log({ text: `Перепроверка не удалась: ${message}`, level: 'warn' });
  } finally {
    autoPickBestStrategyRunning = false;
  }

  // Прежний конфиг оставляем, пока он открывает всё; иначе берём лучший из свежего рейтинга
  const rankings = currentRankings(root);
  const keepPrevious = !!previous && rankings.some((r) => r.strategy === previous && r.failed.length === 0 && rankingPct(r) > 0);
  const best = outcome && !outcome.cancelled && outcome.best && rankingPct(outcome.best) > 0 ? outcome.best.strategy : null;
  const next = keepPrevious ? previous : best ?? previous;

  if (config.bypassStoppedByUser) {
    invalidateStatusCache();
    void refreshTrayMenu(true);
    return outcome && !outcome.cancelled ? 'done' : 'cancelled';
  }

  if (next) {
    try {
      await startBypass(root, next, log);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log({ text: `Обход не запустился после перепроверки: ${message}`, level: 'warn' });
    }
    setSelectedStrategy(next);
    if (previous && next !== previous) {
      logBypassEvent('switched', `Перепроверка: ${strategyLabel(previous)} → ${strategyLabel(next)}`, next);
    }
  }
  // сторож сам поднимет обход, если запуск выше не удался
  bypassWatchdog.setExpected(true);
  invalidateStatusCache();
  mainWindow?.webContents.send('bypass-auto-started');
  void refreshTrayMenu(true);

  if (!outcome) return 'failed';
  return outcome.cancelled ? 'cancelled' : 'done';
}

/** Пользователь вернулся к компьютеру — фоновая перепроверка уже отменяется, дождёмся её */
async function waitForBackgroundRerank(timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (backgroundRerank.isRunning && Date.now() < deadline) await delay(250);
  if (backgroundRerank.isRunning) throw new Error('Идёт фоновая перепроверка конфигов — попробуйте через минуту');
}

/** Сеть сменилась — включаем конфиг, который в ней работал в прошлый раз */
async function refreshNetwork(initial = false): Promise<void> {
  // туннель VPN подменяет маршрут по умолчанию — это не новая сеть; посмотрим, когда отключится
  if (!initial && amneziaVpn.isRunning()) return;
  const fingerprint = interfacesFingerprint();
  if (!initial && fingerprint === networkFingerprint) return;
  networkFingerprint = fingerprint;

  const next = await detectNetwork();
  const changed = next.id !== currentNetwork.id;
  currentNetwork = next;
  const profile = strategyMemory.getProfile(next.id);
  strategyMemory.touch(next.id, next.label);
  if (!changed && !initial) return;
  emitBypassActivity();

  const remembered = profile?.selected ?? null;
  if (initial || !remembered) {
    if (!remembered && config.selectedStrategy) {
      strategyMemory.rememberSelected(next.id, next.label, config.selectedStrategy);
    }
    if (!initial) logBypassEvent('network', `Сеть: ${next.label}`);
    return;
  }

  logBypassEvent('network', `Сеть: ${next.label}`);
  bypassWatchdog.deferHealthCheck(20_000);
  if (remembered === config.selectedStrategy || isBypassAutomationBusy() || bypassWatchdog.isRecovering) return;

  const root = await tryResolveZapretPath({ allowScan: false });
  if (!root) return;
  const status = await getStatus(root, { light: true });
  if (!status.strategies.includes(remembered)) return;

  const previous = config.selectedStrategy;
  setSelectedStrategy(remembered);
  if (!status.bypass.running) return;

  try {
    await startBypass(root, remembered, (line) => sendToolOutput(line.text, line.level));
    bypassWatchdog.setExpected(true);
    logBypassEvent(
      'switched',
      `${next.label}: ${previous ? `${strategyLabel(previous)} → ` : ''}${strategyLabel(remembered)}`,
      remembered
    );
    notify('Сеть сменилась', `${next.label}: включён конфиг ${strategyLabel(remembered)}, который работал здесь раньше.`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    sendToolOutput(`Не удалось включить конфиг сети ${next.label}: ${message}`, 'warn');
  }
  invalidateStatusCache();
  mainWindow?.webContents.send('bypass-auto-started');
  void refreshTrayMenu(true);
}

/** zapret поставлен заново — старые рейтинги относятся к прежним .bat */
function onZapretReinstalled(version: string | null): void {
  strategyMemory.forgetRankings();
  logBypassEvent('update', version ? `Zapret обновлён до ${version}` : 'Zapret переустановлен');
  if (config.backgroundRerank !== false) {
    sendToolOutput('Рейтинг конфигов сброшен — перепроверю их, когда компьютер будет простаивать', 'info');
  }
}

async function saveDiagnosticReport(): Promise<{ saved: boolean; path?: string }> {
  const root = getKnownZapretPath();
  let running = false;
  let strategies = 0;
  if (root) {
    try {
      const status = await getStatus(root, { light: true });
      running = status.bypass.running;
      strategies = status.strategies.length;
    } catch {
      /* отчёт нужен и когда zapret сломан */
    }
  }

  const redact = [os.homedir()];
  try {
    redact.push(os.userInfo().username);
  } catch {
    /* без имени пользователя */
  }

  const report = buildDiagnosticReport({
    generatedAt: Date.now(),
    appVersion: getCurrentAppVersion(),
    platform: `${os.type()} ${os.release()} ${os.arch()}`,
    isAdmin: isWindowsAdmin(),
    settings: {
      autoStartBypass: config.autoStartBypass,
      launchAtStartup: config.launchAtStartup,
      autoPickBestStrategy: config.autoPickBestStrategy,
      bypassAutoRecover: config.bypassAutoRecover,
      bypassAutoSwitch: config.bypassAutoSwitch,
      backgroundRerank: config.backgroundRerank,
      autoUpdateZapret: config.autoUpdateZapret,
      probeSites: config.probeSites,
      bypassStoppedByUser: config.bypassStoppedByUser,
      tgProxyRunning: tgwsProxy.isRunning(),
      tgProxyStats: tgwsProxy.getStats(),
      vpnRunning: amneziaVpn.isRunning(),
    },
    zapret: { path: root, running, strategy: config.selectedStrategy, strategies },
    watchdogHealth: bypassWatchdog.currentHealth,
    network: currentNetwork.label,
    rankings: root ? currentRankings(root) : [],
    rankedAt: root ? strategyMemory.rankedAt(currentNetwork.id, root) : null,
    events: bypassEvents.list(50),
    log: toolLog,
    redact,
  });

  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
  const options = {
    title: 'Сохранить отчёт',
    defaultPath: path.join(app.getPath('desktop'), `skvoz-report-${stamp}.txt`),
    filters: [{ name: 'Текст', extensions: ['txt'] }],
  };
  const result = mainWindow ? await dialog.showSaveDialog(mainWindow, options) : await dialog.showSaveDialog(options);
  if (result.canceled || !result.filePath) return { saved: false };
  fs.writeFileSync(result.filePath, report, 'utf8');
  shell.showItemInFolder(result.filePath);
  return { saved: true, path: result.filePath };
}

function updateTrayIcon(): void {
  if (!tray) return;
  const health = bypassWatchdog.currentHealth;
  const color = trayMenuState.running || health === 'down' ? TRAY_DOT_COLORS[health] : undefined;
  const key = color ? health : 'plain';
  let image = trayIconCache.get(key);
  if (!image) {
    const base = loadAppIcon(32);
    image = color ? withStatusDot(base, color) : base;
    trayIconCache.set(key, image);
  }
  tray.setImage(image);
}

function initBypassAutomation(): void {
  bypassWatchdog.start();
  powerMonitor.on('resume', () => {
    bypassWatchdog.deferHealthCheck(30_000);
    networkFingerprint = '';
  });
  void refreshNetwork(true).catch(() => undefined);
  networkTimer = setInterval(() => void refreshNetwork().catch(() => undefined), NETWORK_POLL_MS);
  backgroundRerank.start();
}

function stopBypassAutomation(): void {
  bypassWatchdog.stop();
  backgroundRerank.stop();
  if (networkTimer) {
    clearInterval(networkTimer);
    networkTimer = null;
  }
}

let config = loadConfig();
// Настройки переживают удаление Skvoz. Новая установка отменяет прежний отказ от zapret
if (consumeFreshInstallMarker(path.dirname(process.execPath)) && config.skipAutoBootstrap) {
  config.skipAutoBootstrap = false;
  saveConfig(config);
}

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

/** background — автообновление в фоне: интерфейс показывает прогресс, но не блокируется */
function sendDownloadProgress(progress: DownloadProgress, background = false): void {
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
  mainWindow?.webContents.send('download-progress', { ...progress, background });
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

      const reinstalled = result.state.autoFixed && result.path !== config.zapretPath;
      config.zapretPath = result.path;
      config.bootstrapDone = true;
      if (reinstalled) onZapretReinstalled(result.state.selected?.version ?? null);
      config.skipAutoBootstrap = false;
      saveConfig(config);
      bootstrapState = result.state;
      mainWindow?.webContents.send('bootstrap-complete', result.state);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      rememberToolLog(message, 'error');
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
  let stoppedForUpdate = false;
  let bypassRestored = false;
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
      stoppedForUpdate = true;
      await stopBypass((line) => sendToolOutput(line.text, line.level));
      await delay(900);
    }

    const result = await downloadOfficialZapret(config.installBase, root, (progress) =>
      sendDownloadProgress(progress, true)
    );
    config.zapretPath = result.installPath;
    saveConfig(config);
    onZapretReinstalled(result.version);
    sanitizeSelectedStrategy(result.installPath);
    invalidateStatusCache();

    if (wasRunning) {
      const fresh = await getStatus(result.installPath, { fresh: true });
      const strategy = config.selectedStrategy ?? fresh.selectedStrategy;
      if (strategy) {
        await startBypass(result.installPath, strategy, (line) => sendToolOutput(line.text, line.level));
        markBypassExpectedRunning(true);
        bypassRestored = true;
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
    // Обход остановили ради обновления — без него пользователь не должен остаться
    if (stoppedForUpdate && !bypassRestored) {
      const fallbackRoot = isValidZapretPath(config.zapretPath) ? config.zapretPath : root;
      const strategy = config.selectedStrategy;
      if (strategy) {
        try {
          await startBypass(fallbackRoot, strategy, (line) => sendToolOutput(line.text, line.level));
          markBypassExpectedRunning(true);
          sendToolOutput('Обход снова запущен на прежней версии zapret', 'success');
        } catch (restartError) {
          const text = restartError instanceof Error ? restartError.message : String(restartError);
          notify('Обход остановлен', `Обновление zapret не удалось, и обход не перезапустился: ${text}`);
        }
      }
    }
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
    const silentStartup = process.argv.includes(STARTUP_LAUNCH_ARG) && config.minimizeToTray;
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
    if (!appQuitting && config.minimizeToTray && tray) {
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

const TRAY_WINDOW_SIZE = { width: 330, height: 408 };
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
      // скрытое окно не должно «замерзать», иначе при открытии мелькает старый кадр
      backgroundThrottling: false,
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
  // Показываем прозрачным, даём интерфейсу сбросить анимацию и отрисовать первый кадр,
  // и только потом проявляем — без вспышки прошлого состояния
  const win = trayWindow;
  win.setOpacity(0);
  win.show();
  win.focus();
  win.webContents.send('tray-reveal');
  setTimeout(() => {
    if (!win.isDestroyed() && win.isVisible()) win.setOpacity(1);
  }, 40);
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
  const zapret = trayMenuState.running ? `обход включён (${HEALTH_LABEL[bypassWatchdog.currentHealth]})` : 'обход выключен';
  const tg = tgwsProxy.isRunning() ? 'TG proxy работает' : 'TG proxy выключен';
  const vpn = amneziaVpn.isRunning() ? 'VPN включён' : 'VPN выключен';
  return `Skvoz — ${zapret}, ${tg}, ${vpn}`;
}

async function refreshTrayMenu(force = false): Promise<void> {
  if (!tray) return;

  const cacheFresh = !force && Date.now() - trayMenuStateAt < TRAY_MENU_CACHE_MS;
  if (!cacheFresh) {
    let running = false;
    let canStart = false;
    let strategy: string | null = null;
    let strategies: string[] = [];

    try {
      const zapretPath = getKnownZapretPath();
      if (zapretPath) {
        sanitizeSelectedStrategy(zapretPath);
        const status = await getStatus(zapretPath, { light: true });
        running = status.bypass.running;
        strategy = config.selectedStrategy ?? status.selectedStrategy;
        strategies = status.strategies;
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

    trayMenuState = { running, canStart, strategy, strategies };
    trayMenuStateAt = Date.now();
  }

  rebuildTrayMenu();
}

/** Меню без нового опроса zapret — когда сменилось только состояние сторожа */
function rebuildTrayMenu(): void {
  if (!tray) return;
  tray.setContextMenu(buildTrayMenu());
  tray.setToolTip(trayTooltip());
  updateTrayIcon();
}

function buildTrayMenu(): Menu {
  const { running, canStart, strategy, strategies } = trayMenuState;
  const tgRunning = tgwsProxy.isRunning();
  const tg = tgwsProxy.getConfig();
  const vpnRunning = amneziaVpn.isRunning();
  const vpnSummary = amneziaVpn.getSummary();
  const health = bypassWatchdog.currentHealth;
  const since = running ? bypassEvents.runningSince() : null;
  const automationBusy = isBypassAutomationBusy() || bypassWatchdog.isRecovering;

  const bypassState = running ? HEALTH_LABEL[health] : 'выключен';
  const networkLine = [
    currentNetwork.id !== UNKNOWN_NETWORK.id ? currentNetwork.label : null,
    since ? `работает с ${formatClock(since.at)}` : null,
  ].filter(Boolean).join(' · ');

  const strategyItems: Electron.MenuItemConstructorOptions[] = strategies.length
    ? strategies.map((item) => ({
        label: strategyLabel(item),
        type: 'radio',
        checked: item === strategy,
        enabled: !automationBusy,
        click: () => void trayChooseStrategy(item),
      }))
    : [{ label: 'Конфиги не найдены', enabled: false }];

  return Menu.buildFromTemplate([
    { label: 'Открыть Skvoz', click: () => focusMainWindow() },
    { type: 'separator' },
    { label: `Обход: ${bypassState}`, enabled: false },
    ...(networkLine ? [{ label: networkLine, enabled: false }] : []),
    running
      ? { label: 'Выключить обход', click: () => void traySetBypass(false) }
      : { label: 'Включить обход', enabled: canStart, click: () => void traySetBypass(true) },
    { label: 'Перезапустить обход', enabled: running && !automationBusy, click: () => void trayRestartBypass() },
    {
      label: `Конфиг: ${strategy ? strategyLabel(strategy) : 'не выбран'}`,
      enabled: strategies.length > 0,
      submenu: strategyItems,
    },
    { type: 'separator' },
    { label: `Telegram-прокси: ${tgRunning ? `работает · ${tg.host}:${tg.port}` : 'выключен'}`, enabled: false },
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
    { label: `VPN: ${vpnRunning ? `включён · ${vpnSummary?.endpoint ?? ''}` : amneziaVpn.isConfigured() ? 'выключен' : 'нет конфига'}`, enabled: false },
    {
      label: vpnRunning ? 'Выключить VPN' : 'Включить VPN',
      enabled: vpnRunning || amneziaVpn.isConfigured(),
      click: () => void traySetVpn(!vpnRunning),
    },
    { type: 'separator' },
    { label: 'Настройки…', click: () => focusMainWindow('settings') },
    { label: 'Журнал и диагностика…', click: () => focusMainWindow('tools') },
    { type: 'separator' },
    {
      label: 'Выход',
      click: () => quitApp(),
    },
  ]);
}

function formatClock(timestamp: number): string {
  const date = new Date(timestamp);
  const time = date.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  if (date.toDateString() === new Date().toDateString()) return time;
  return `${date.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' })} ${time}`;
}

/** Смена конфига из трея; если обход работает — перезапускаем его с новым */
async function trayChooseStrategy(strategy: string): Promise<void> {
  try {
    if (isBypassAutomationBusy() || bypassWatchdog.isRecovering) {
      throw new Error('Сейчас идёт подбор или восстановление — попробуйте через минуту');
    }
    const zapretPath = await requireZapretPath();
    const status = await getStatus(zapretPath);
    if (!status.strategies.includes(strategy)) throw new Error(`Конфиг не найден: ${strategy}`);
    const previous = config.selectedStrategy;
    setSelectedStrategy(strategy);
    if (status.bypass.running && strategy !== previous) {
      const log = (line: { text: string; level: string }): void => sendToolOutput(line.text, line.level);
      sendToolOutput(`Смена конфига из трея: ${strategyLabel(strategy)}`, 'info');
      await stopBypass(log);
      await delay(600);
      await startBypass(zapretPath, strategy, log);
      if (!(await waitForBypassRunning())) throw new Error('winws.exe не запустился с новым конфигом');
      markBypassExpectedRunning(true);
    }
    invalidateStatusCache();
    mainWindow?.webContents.send('bypass-auto-started');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    sendToolOutput(`Ошибка: ${message}`, 'warn');
    notify('Конфиг не сменился', message);
  } finally {
    await refreshTrayMenu(true);
  }
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

async function traySetVpn(enable: boolean): Promise<void> {
  try {
    if (enable) await amneziaVpn.connect();
    else await amneziaVpn.disconnect();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    sendToolOutput(`[VPN] ${message}`, 'error');
    notify('VPN не подключился', message);
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
      await waitForBackgroundRerank();
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
    throw new Error('Zapret не установлен. Нажмите «Установить zapret» на главной.');
  }
  return resolved;
}

function rememberToolLog(text: string, level: string): void {
  toolLog.push({ at: Date.now(), level, text });
  if (toolLog.length > TOOL_LOG_LIMIT) toolLog.splice(0, toolLog.length - TOOL_LOG_LIMIT);
  if (level === 'error' || level === 'warn') saveLogProblems(toolErrorsFile, toolLog);
}

function sendToolOutput(text: string, level: string): void {
  // служебные строки подбора (JSON для интерфейса) в отчёт не нужны
  if (!text.startsWith('__')) rememberToolLog(text, level);
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
  /** папка zapret, на которой снят рейтинг; в старых файлах её нет */
  root?: string;
}

function lastTestResultsPath(): string {
  return path.join(app.getPath('userData'), 'last-test.json');
}

function saveLastTestResults(payload: TestResultPayload, root: string): void {
  try {
    const record: LastTestResults = { ...payload, at: new Date().toISOString(), root };
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
  if (bypassWatchdog.isRecovering || backgroundRerank.isRunning) {
    throw new Error('Идёт автовосстановление обхода — попробуйте через минуту');
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
      // ручной подбор показываем в «последних результатах» даже прерванным
      saveLastTestResults({ ...outcome, quick: !!options.quick }, zapretPath);
      strategyMemory.saveRankings(
        currentNetwork.id,
        currentNetwork.label,
        zapretPath,
        outcome.rankings,
        !options.quick && !outcome.cancelled
      );
    }

    const best = outcome.best;
    if (outcome.cancelled) {
      await applyDefaultStrategyFallback(zapretPath);
      return { ...none, cancelled: true, partialBest: best?.strategy ?? null };
    }

    if (best?.strategy && status.strategies.includes(best.strategy)) {
      setSelectedStrategy(best.strategy);
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

const APP_UPDATE_INTERVAL_MS = 6 * 60 * 60_000;
const APP_UPDATE_RETRY_MS = 15 * 60_000;
let appUpdateTimer: ReturnType<typeof setTimeout> | null = null;
let appUpdateNotifiedVersion: string | null = null;

/** Проверка при запуске, затем раз в 6 часов; при сбое сети — повтор через 15 минут. */
function scheduleAppUpdateCheck(delayMs = 3500): void {
  if (appUpdateTimer) clearTimeout(appUpdateTimer);
  appUpdateTimer = setTimeout(() => {
    appUpdateTimer = null;
    void checkAppUpdate()
      .then((info) => {
        notifyAppUpdateIfNeeded(info);
        notifyAppUpdateInTray(info);
        scheduleAppUpdateCheck(info.checkFailed ? APP_UPDATE_RETRY_MS : APP_UPDATE_INTERVAL_MS);
      })
      .catch(() => scheduleAppUpdateCheck(APP_UPDATE_RETRY_MS));
  }, delayMs);
}

/** Окно свёрнуто в трей — показываем системное уведомление, один раз на версию. */
function notifyAppUpdateInTray(info: AppUpdateStatus): void {
  if (!shouldNotifyAppUpdate(info) || !info.latest) return;
  if (mainWindow?.isVisible() || appUpdateNotifiedVersion === info.latest) return;
  if (!Notification.isSupported()) return;
  appUpdateNotifiedVersion = info.latest;
  const notification = new Notification({
    title: 'Доступно обновление Skvoz',
    body: `Версия ${info.latest} — нажмите, чтобы открыть`,
  });
  notification.on('click', () => focusMainWindow());
  notification.show();
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

  ipcMain.handle('show-main-window', (_e, view?: string) => {
    trayWindow?.hide();
    focusMainWindow(typeof view === 'string' ? view : undefined);
    return { ok: true };
  });

  ipcMain.handle('set-bypass-auto-recover', (_e, enabled: boolean) => {
    config.bypassAutoRecover = !!enabled;
    saveConfig(config);
    return { bypassAutoRecover: config.bypassAutoRecover };
  });

  ipcMain.handle('set-bypass-auto-switch', (_e, enabled: boolean) => {
    config.bypassAutoSwitch = !!enabled;
    saveConfig(config);
    return { bypassAutoSwitch: config.bypassAutoSwitch };
  });

  ipcMain.handle('set-background-rerank', (_e, enabled: boolean) => {
    config.backgroundRerank = !!enabled;
    saveConfig(config);
    return { backgroundRerank: config.backgroundRerank };
  });

  ipcMain.handle('set-probe-sites', (_e, sites: unknown) => {
    const raw = Array.isArray(sites) ? sites.filter((s): s is string => typeof s === 'string') : [];
    const valid = raw.map((s) => s.trim()).filter((s) => s && normalizeProbeSite(s));
    config.probeSites = [...new Set(valid)].slice(0, 5);
    saveConfig(config);
    return { probeSites: config.probeSites, rejected: raw.filter((s) => s.trim() && !normalizeProbeSite(s)) };
  });

  ipcMain.handle('get-bypass-activity', () => ({
    health: bypassWatchdog.currentHealth,
    healthLabel: HEALTH_LABEL[bypassWatchdog.currentHealth],
    network: currentNetwork.label,
    since: bypassEvents.runningSince(),
    events: bypassEvents.list(15),
  }));

  ipcMain.handle('save-diagnostic-report', async () => saveDiagnosticReport());

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
    setSelectedStrategy(strategy);
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
    const afterRerank = backgroundRerank.isRunning;
    await waitForBackgroundRerank();
    const zapretPath = await requireZapretPath();
    if (afterRerank) invalidateStatusCache();
    const status = await getStatus(zapretPath);
    const strategy = config.selectedStrategy ?? status.selectedStrategy;
    if (!strategy) throw new Error('Стратегия не выбрана');
    if (!status.strategies.includes(strategy)) {
      throw new Error(`Стратегия не найдена: ${strategy}`);
    }
    if (status.bypass.running) {
      // перепроверка, закончившись, сама подняла обход — это и было нужно
      if (afterRerank) {
        clearBypassStoppedByUser();
        markBypassExpectedRunning(true);
        await refreshTrayMenu(true);
        return { ok: true };
      }
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
    await waitForBackgroundRerank();
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
    await getProcessStatus(
      await requireZapretPath(),
      (line) => sendToolOutput(line.text, line.level),
      config.selectedStrategy
    );
    return { ok: true };
  });

  ipcMain.handle('check-updates', async () => checkForUpdates(await requireZapretPath()));

  ipcMain.handle('check-app-update', async () => checkAppUpdate());

  ipcMain.handle('get-app-version', () => getCurrentAppVersion());

  ipcMain.handle('download-app-update', async () => {
    // Уже скачано (в диалоге нажали «Отмена») — не качаем повторно
    if (pendingAppUpdate && fs.existsSync(pendingAppUpdate.stagingPath)) return pendingAppUpdate;
    pendingAppUpdate = await downloadAppUpdate(sendDownloadProgress);
    return pendingAppUpdate;
  });

  ipcMain.handle('apply-app-update', async () => {
    if (!pendingAppUpdate) {
      throw new Error('Сначала скачайте обновление');
    }
    const update = pendingAppUpdate;
    pendingAppUpdate = null;
    // Запоминаем, работал ли прокси, чтобы поднять его после перезапуска
    await tgwsProxy.setConfig({ enabled: tgwsProxy.isRunning() }).catch(() => undefined);
    amneziaVpn.setSettings({ enabled: amneziaVpn.isRunning() });
    scheduleAppUpdateApply(update);
    setTimeout(() => quitApp(), 600);
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

    const existing = isValidZapretPath(config.zapretPath) ? config.zapretPath : null;
    const install = existing
      ? downloadOfficialZapret(config.installBase, existing, sendDownloadProgress)
      : installZapret(config.installBase, sendDownloadProgress);
    const result = await install.catch((error) => {
      rememberToolLog(error instanceof Error ? error.message : String(error), 'error');
      throw error;
    });

    config.zapretPath = result.installPath;
    config.bootstrapDone = true;
    config.skipAutoBootstrap = false;
    saveConfig(config);
    onZapretReinstalled(result.version);

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

  // ── AmneziaWG VPN ─────────────────────────────────────────────────────

  ipcMain.handle('vpn-status', () => amneziaVpn.getState());

  ipcMain.handle('vpn-import-file', async () => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      title: 'Выберите конфиг AmneziaWG',
      properties: ['openFile'],
      filters: [{ name: 'Конфиг AmneziaWG / WireGuard', extensions: ['conf'] }],
    });
    if (result.canceled || result.filePaths.length === 0) return { canceled: true as const };
    if (fs.statSync(result.filePaths[0]).size > 64 * 1024) throw new Error('Файл слишком большой для конфига');
    const summary = await amneziaVpn.importConfig(fs.readFileSync(result.filePaths[0], 'utf8'));
    return { canceled: false as const, summary };
  });

  ipcMain.handle('vpn-import-text', async (_e, text: string) => {
    if (typeof text !== 'string' || text.length > 64 * 1024) throw new Error('Неверный конфиг');
    return { summary: await amneziaVpn.importConfig(text) };
  });

  ipcMain.handle('vpn-warp-endpoints', () => WARP_ENDPOINTS);

  ipcMain.handle('vpn-generate-warp', async (_e, options: WarpGenerateOptions) => {
    const result = await createWarpVpn(
      { endpoint: String(options?.endpoint ?? 'auto'), preset: options?.preset ?? 'auto' },
      (text) => {
        sendToolOutput(`[VPN] ${text}`, 'info');
        mainWindow?.webContents.send('vpn-progress', { text });
      },
      openWarpRoute
    );
    sendToolOutput(`[VPN] Подключено через ${result.candidate.endpoint}`, 'success');
    return result;
  });

  ipcMain.handle('vpn-export-config', async () => {
    const text = amneziaVpn.readConfigText();
    const result = await dialog.showSaveDialog(mainWindow!, {
      title: 'Сохранить конфиг VPN',
      defaultPath: 'Skvoz-VPN.conf',
      filters: [{ name: 'Конфиг AmneziaWG', extensions: ['conf'] }],
    });
    if (result.canceled || !result.filePath) return { canceled: true as const };
    fs.writeFileSync(result.filePath, text, 'utf8');
    return { canceled: false as const, filePath: result.filePath };
  });

  ipcMain.handle('vpn-remove-config', async () => {
    await amneziaVpn.removeConfig();
    return { ok: true };
  });

  ipcMain.handle('vpn-connect', async () => {
    await amneziaVpn.connect();
    return { ok: true };
  });

  ipcMain.handle('vpn-disconnect', async () => {
    await amneziaVpn.disconnect();
    return { ok: true };
  });

  ipcMain.handle('vpn-set-autostart', (_e, enabled: boolean) => {
    amneziaVpn.setSettings({ autostart: !!enabled });
    return { autostart: amneziaVpn.getSettings().autostart };
  });

  ipcMain.handle('open-external', async (_e, url: string) => {
    // Только веб-ссылки и ссылки Telegram — никаких file:// и запуска программ
    if (!/^(https:\/\/|tg:\/\/)/i.test(String(url))) throw new Error('Недопустимая ссылка');
    await shell.openExternal(url);
    return { ok: true };
  });
}

/** view — страница, которую открыть (из меню трея: «Настройки», «Журнал») */
function focusMainWindow(view?: string): void {
  const navigate = (): void => {
    if (!view || !mainWindow) return;
    const target = mainWindow;
    if (target.webContents.isLoading()) {
      target.webContents.once('did-finish-load', () => target.webContents.send('navigate', view));
    } else {
      target.webContents.send('navigate', view);
    }
  };
  const show = (): void => {
    if (!mainWindow) {
      createWindow();
      navigate();
      return;
    }

    if (mainWindow.isMinimized()) {
      mainWindow.restore();
    }
    mainWindow.show();
    mainWindow.focus();
    navigate();
  };

  if (app.isReady()) {
    show();
    return;
  }

  void app.whenReady().then(show);
}

/** Сворачивание в трей не должно мешать настоящему выходу (меню трея, установка обновления). */
let appQuitting = false;
app.on('before-quit', () => {
  appQuitting = true;
});

function quitApp(): void {
  appQuitting = true;
  app.quit();
  // Если что-то держит процесс (зависший сокет прокси и т.п.) — выходим принудительно
  setTimeout(() => app.exit(0), 5_000).unref();
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
    initBypassAutomation();
    initTgwsProxy();
    initVpn();
    scheduleZapretAutoUpdate();

    app.on('before-quit', () => {
      stopBypassAutomation();
      void tgwsProxy.stop();
      // Без окна Skvoz VPN нечем выключить — гасим его вместе с приложением
      amneziaVpn.stopOnQuit();
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
