import {
  appendJournalLine,
  clearJournal,
  copyJournal,
  focusJournal,
  isJournalCollapsed,
  restoreJournalCollapsed,
  setJournalCollapsed,
  setJournalStatus,
  setJournalTitle,
  type JournalLevel,
} from './journal.js';
import { initMotion, moveTabPill, playPowerWave } from './motion.js';
import { confirmModal, formatUserError, initUi, showErrorModal, showInfoModal, toast } from './ui.js';
import { enhanceSelect, type CustomSelectHandle } from './custom-select.js';
import {
  initLoading,
  mapDownloadStage,
  setActionBusy,
  setGlobalLoad,
  setHeroLoading,
  setInlineTestProgress,
  setPickProgress,
  setStatusLoading,
} from './loading.js';

interface BootstrapState {
  stage: string;
  message: string;
  isOfficial: boolean;
  warnings: string[];
  autoFixed: boolean;
}

interface DownloadProgress {
  stage: string;
  percent: number;
  message: string;
  /** автообновление zapret в фоне */
  background?: boolean;
}

interface AppUpdateInfo {
  current: string;
  latest: string | null;
  upToDate: boolean;
  checkFailed?: boolean;
  releasePage: string | null;
  releaseNotes: string | null;
}

interface TgwsProxyConfig {
  enabled: boolean;
  port: number;
  host: string;
  secretHex: string;
  autostart: boolean;
}

interface TgwsProxyStats {
  total: number;
  active: number;
  ws: number;
  tcp: number;
  bad: number;
}

interface TgwsProxyState {
  running: boolean;
  config: TgwsProxyConfig;
  stats: TgwsProxyStats;
  proxyLink: string | null;
}

interface AccessResult {
  id: 'discord' | 'youtube' | 'telegram';
  name: string;
  status: 'ok' | 'partial' | 'fail';
  ms: number | null;
  detail: string;
}

interface VpnConfigSummary {
  endpoint: string;
  address: string;
  dns: string;
  fullTunnel: boolean;
  obfuscated: boolean;
}

interface VpnState {
  bundled: boolean;
  configured: boolean;
  running: boolean;
  busy: boolean;
  serviceState: string;
  summary: VpnConfigSummary | null;
  autostart: boolean;
  handshakeAgoSec: number | null;
  rxBytes: number;
  txBytes: number;
}

interface ZapretApi {
  vpnStatus(): Promise<VpnState>;
  vpnImportFile(): Promise<{ canceled: true } | { canceled: false; summary: VpnConfigSummary }>;
  vpnImportText(text: string): Promise<{ summary: VpnConfigSummary }>;
  vpnRemoveConfig(): Promise<{ ok: boolean }>;
  vpnWarpEndpoints(): Promise<Array<{ value: string; label: string }>>;
  vpnGenerateWarp(options: { endpoint: string; preset: string }): Promise<{
    summary: VpnConfigSummary;
    candidate: { endpoint: string; preset: string };
    connected: boolean;
  }>;
  vpnExportConfig(): Promise<{ canceled: true } | { canceled: false; filePath: string }>;
  onVpnProgress(callback: (payload: { text: string }) => void): () => void;
  vpnConnect(): Promise<{ ok: boolean }>;
  vpnDisconnect(): Promise<{ ok: boolean }>;
  vpnSetAutostart(enabled: boolean): Promise<{ autostart: boolean }>;
  tgwsGetConfig(): Promise<TgwsProxyConfig>;
  tgwsSetConfig(updates: Partial<TgwsProxyConfig>): Promise<{ ok: boolean }>;
  tgwsStart(): Promise<{ ok: boolean }>;
  tgwsStop(): Promise<{ ok: boolean }>;
  tgwsStatus(): Promise<TgwsProxyState>;
  tgwsProxyLink(): Promise<string | null>;
  checkAccess(): Promise<AccessResult[]>;
  openExternal(url: string): Promise<{ ok: boolean }>;
  getConfig(): Promise<{
    zapretPath: string;
    selectedStrategy: string | null;
    launchAtStartup?: boolean;
    autoStartBypass?: boolean;
    autoPickBestStrategy?: boolean;
    minimizeToTray?: boolean;
    autoUpdateZapret?: boolean;
    skipAutoBootstrap?: boolean;
  }>;
  getDashboardState(options?: { light?: boolean }): Promise<{
    config: {
      zapretPath: string;
      selectedStrategy: string | null;
      launchAtStartup?: boolean;
      autoStartBypass?: boolean;
      autoPickBestStrategy?: boolean;
      minimizeToTray?: boolean;
      autoUpdateZapret?: boolean;
      bypassAutoRecover?: boolean;
      bypassAutoSwitch?: boolean;
      backgroundRerank?: boolean;
      gameMode?: boolean;
      gameProcesses?: string[];
      probeSites?: string[];
      skipAutoBootstrap?: boolean;
    };
    status: StatusPayload;
  }>;
  setLaunchAtStartup(enabled: boolean): Promise<{ launchAtStartup: boolean }>;
  setAutoStartBypass(enabled: boolean): Promise<{ autoStartBypass: boolean; launchAtStartup?: boolean }>;
  setAutoPickBestStrategy(enabled: boolean): Promise<{ autoPickBestStrategy: boolean }>;
  setMinimizeToTray(enabled: boolean): Promise<{ minimizeToTray: boolean }>;
  setAutoUpdateZapret(enabled: boolean): Promise<{ autoUpdateZapret: boolean }>;
  setBypassAutoRecover(enabled: boolean): Promise<{ bypassAutoRecover: boolean }>;
  setBypassAutoSwitch(enabled: boolean): Promise<{ bypassAutoSwitch: boolean }>;
  setBackgroundRerank(enabled: boolean): Promise<{ backgroundRerank: boolean }>;
  setGameMode(enabled: boolean): Promise<{ gameMode: boolean }>;
  setGameProcesses(names: string[]): Promise<{ gameProcesses: string[]; rejected: string[] }>;
  setProbeSites(sites: string[]): Promise<{ probeSites: string[]; rejected: string[] }>;
  getBypassActivity(): Promise<BypassActivity>;
  saveDiagnosticReport(): Promise<{ saved: boolean; path?: string }>;
  onBypassActivityChanged(callback: () => void): () => void;
  onNavigate(callback: (view: string) => void): () => void;
  getBootstrapState(): Promise<BootstrapState | null>;
  rescanZapret(): Promise<BootstrapState | null>;
  getStatus(): Promise<StatusPayload>;
  setZapretPath(): Promise<{ zapretPath: string; selectedStrategy: string | null }>;
  setStrategy(strategy: string): Promise<{ zapretPath: string; selectedStrategy: string | null }>;
  startBypass(): Promise<{ ok: boolean }>;
  stopBypass(): Promise<{ ok: boolean }>;
  recoverBypassNow(): Promise<{ ok: boolean; health: BypassHealth }>;
  fullRemoveZapret(): Promise<{ ok: boolean; removedPaths: string[] }>;
  setGameFilter(mode: string): Promise<{ ok: boolean; restarted?: boolean }>;
  toggleIpset(): Promise<{ ok: boolean; ipset: string }>;
  setIpsetMode(mode: 'loaded' | 'any' | 'none'): Promise<{ ok: boolean; ipset: 'loaded' | 'any' | 'none'; restarted?: boolean }>;
  updateIpsetList(): Promise<{ ok: boolean }>;
  updateHostsFile(): Promise<{ ok: boolean }>;
  removeZapretServices(): Promise<{ ok: boolean }>;
  getUserLists(): Promise<{ lists: Record<UserListKind, string> }>;
  saveUserList(kind: UserListKind, content: string): Promise<{ ok: boolean; lists: Record<UserListKind, string> }>;
  addUserListEntries(
    kind: UserListKind,
    entries: string[]
  ): Promise<{ ok: boolean; lists: Record<UserListKind, string>; added: string[]; skipped: string[] }>;
  setCheckUpdates(enabled: boolean): Promise<{ ok: boolean }>;
  runDiagnostics(): Promise<{ ok: boolean }>;
  runTests(mode?: 'current' | 'all'): Promise<{ ok: boolean }>;
  getAutoPickPending(): Promise<{ pending: boolean }>;
  runPickBestStrategy(options?: { quick?: boolean }): Promise<{
    cancelled: boolean;
    strategy: string | null;
    score: number;
    okChecks: number;
    totalChecks: number;
    partialBest: string | null;
  }>;
  getLastTestResults(): Promise<(TestResultPayload & { at: string }) | null>;
  cancelPickBestStrategy(): Promise<{ ok: boolean }>;
  completePostBootstrap(): Promise<{ ok: boolean }>;
  getProcessStatus(): Promise<{ ok: boolean }>;
  checkUpdates(): Promise<{ current: string | null; latest: string | null; upToDate: boolean; checkFailed: boolean }>;
  checkAppUpdate(): Promise<AppUpdateInfo>;
  getAppVersion(): Promise<string>;
  downloadAppUpdate(): Promise<{ stagingPath: string; version: string }>;
  applyAppUpdate(): Promise<{ ok: boolean; version: string }>;
  dismissAppUpdate(version: string): Promise<{ dismissedAppVersion: string | null }>;
  openAppReleasePage(): Promise<{ ok: boolean }>;
  downloadZapret(): Promise<{ installPath: string; version: string }>;
  openDownloadPage(): Promise<{ ok: boolean }>;
  openAppRepo(): Promise<{ ok: boolean }>;
  isAdmin(): Promise<boolean>;
  restartAsAdmin(): Promise<{ ok: boolean }>;
  onDownloadProgress(callback: (progress: DownloadProgress) => void): () => void;
  onToolOutput(callback: (line: { text: string; level: string }) => void): () => void;
  onBootstrapStatus(callback: (state: BootstrapState) => void): () => void;
  onBootstrapComplete(callback: (state: BootstrapState) => void): () => void;
  onBypassAutoStarted(callback: () => void): () => void;
  onAutoStartBlocked(callback: (payload: { reason: 'admin' }) => void): () => void;
  onStrategyAutoPicked(callback: (payload: {
    strategy: string;
    score: number;
    okChecks: number;
    totalChecks: number;
  }) => void): () => void;
  onAppWindowVisibility(callback: (payload: { visible: boolean }) => void): () => void;
  onAppUpdateAvailable(callback: (info: AppUpdateInfo) => void): () => void;
}

interface StatusPayload {
  pathsValid: boolean;
  bypass: { running: boolean; pid: number | null };
  zapretService: { exists: boolean; running: boolean; state: string; strategy: string | null };
  windivertService: { exists: boolean; running: boolean; state: string };
  settings: { gameFilter: string; ipset: string; checkUpdates: boolean };
  strategies: string[];
  selectedStrategy: string | null;
  installedVersion: string | null;
  latestVersion: string | null;
  updateAvailable: boolean;
  isOfficial: boolean;
  officialWarnings: string[];
  foundInstalls: number;
}

declare global {
  interface Window {
    zapretApi: ZapretApi;
  }
}

const TEST_PROGRESS_PREFIX = '__TEST_PROGRESS__:';
const TEST_RESULT_PREFIX = '__TEST_RESULT__:';
const TEST_STRATEGY_DONE_PREFIX = '__TEST_STRATEGY_DONE__:';

interface StrategyRanking {
  strategy: string;
  score: number;
  maxScore: number;
  okChecks: number;
  totalChecks: number;
  failed?: string[];
}

interface TestResultPayload {
  rankings: StrategyRanking[];
  best: StrategyRanking | null;
  targetCount: number;
  cancelled?: boolean;
  quick?: boolean;
}

type UserListKind = 'general' | 'exclude-domains' | 'exclude-ips';

const USER_LIST_HINTS: Record<UserListKind, string> = {
  general: 'Домены и IP, которые пойдут через обход.',
  'exclude-domains': 'Домены, которые zapret не трогает. Исключения важнее списка обхода.',
  'exclude-ips': 'IP или подсеть CIDR — не попадут под IPSet-фильтр.',
};

const api = window.zapretApi;

const ACTION_BUTTON_IDS = [
  'btnToggle',
  'btnDiagnostics',
  'btnFindBest',
  'btnFullCheck',
  'btnTests',
  'btnProcessStatus',
  'btnCheckUpdates',
  'btnFullRemove',
  'btnRescan',
  'btnRescanEmpty',
  'btnChangePath',
  'btnChangePathEmpty',
  'btnDownload',
  'btnDownloadInline',
  'btnClearLog',
];

const els = {
  statusBadge: document.getElementById('statusBadge')!,
  statusText: document.getElementById('statusText')!,
  statusTg: document.getElementById('statusTg')!,
  statusVpn: document.getElementById('statusVpn')!,
  officialWarning: document.getElementById('officialWarning')!,
  adminBanner: document.getElementById('adminBanner')!,
  btnRestartAdmin: document.getElementById('btnRestartAdmin') as HTMLButtonElement,
  bootstrapBanner: document.getElementById('bootstrapBanner')!,
  appUpdateBanner: document.getElementById('appUpdateBanner')!,
  appUpdateBannerText: document.getElementById('appUpdateBannerText')!,
  btnInstallAppUpdate: document.getElementById('btnInstallAppUpdate') as HTMLButtonElement,
  btnOpenAppRelease: document.getElementById('btnOpenAppRelease') as HTMLButtonElement,
  btnDismissAppUpdate: document.getElementById('btnDismissAppUpdate') as HTMLButtonElement,
  appVersionLine: document.getElementById('appVersionLine')!,
  emptyState: document.getElementById('emptyState')!,
  emptyStateTitle: document.getElementById('emptyStateTitle')!,
  emptyStateHint: document.getElementById('emptyStateHint')!,
  emptyStateActions: document.getElementById('emptyStateActions')!,
  mainPanel: document.getElementById('mainPanel')!,
  officialBadge: document.getElementById('officialBadge')!,
  zapretPath: document.getElementById('zapretPath')!,
  versionLine: document.getElementById('versionLine')!,
  updZapretVersion: document.getElementById('updZapretVersion')!,
  updAppVersion: document.getElementById('updAppVersion')!,
  btnAppChangelog: document.getElementById('btnAppChangelog') as HTMLButtonElement,
  updatesLockHint: document.getElementById('updatesLockHint')!,
  btnRescan: document.getElementById('btnRescan') as HTMLButtonElement,
  btnRescanEmpty: document.getElementById('btnRescanEmpty') as HTMLButtonElement,
  btnChangePath: document.getElementById('btnChangePath') as HTMLButtonElement,
  btnChangePathEmpty: document.getElementById('btnChangePathEmpty') as HTMLButtonElement,
  btnDownload: document.getElementById('btnDownload') as HTMLButtonElement,
  btnDownloadInline: document.getElementById('btnDownloadInline') as HTMLButtonElement,
  linkAppRepo: document.getElementById('linkAppRepo') as HTMLButtonElement,
  linkCheckAppUpdate: document.getElementById('linkCheckAppUpdate') as HTMLButtonElement,
  linkAppDocs: document.getElementById('linkAppDocs') as HTMLButtonElement,
  linkOfficial: document.getElementById('linkOfficial') as HTMLButtonElement,
  progressWrap: document.getElementById('progressWrap')!,
  progressFill: document.getElementById('progressFill')!,
  progressText: document.getElementById('progressText')!,
  progressTitle: document.getElementById('progressTitle')!,
  progressPct: document.getElementById('progressPct')!,
  progressStages: document.getElementById('progressStages')!,
  heroLoader: document.getElementById('heroLoader')!,
  heroLogoWrap: document.getElementById('heroLogoWrap')!,
  powerZone: document.getElementById('powerZone')!,
  btnToggle: document.getElementById('btnToggle') as HTMLButtonElement,
  powerSpinner: document.getElementById('powerSpinner')!,
  btnToggleIcon: document.getElementById('btnToggleIcon')!,
  btnToggleText: document.getElementById('btnToggleText')!,
  strategySelect: document.getElementById('strategySelect') as HTMLSelectElement,
  configMeta: document.getElementById('configMeta')!,
  gameFilterSelect: document.getElementById('gameFilterSelect') as HTMLSelectElement,
  ipsetToggle: document.getElementById('ipsetToggle') as HTMLInputElement,
  ipsetModeSelect: document.getElementById('ipsetModeSelect') as HTMLSelectElement,
  btnUpdateIpset: document.getElementById('btnUpdateIpset') as HTMLButtonElement,
  btnUpdateHosts: document.getElementById('btnUpdateHosts') as HTMLButtonElement,
  btnRemoveServices: document.getElementById('btnRemoveServices') as HTMLButtonElement,
  checkUpdatesToggle: document.getElementById('checkUpdatesToggle') as HTMLInputElement,
  launchAtStartupToggle: document.getElementById('launchAtStartupToggle') as HTMLInputElement,
  autoStartBypassToggle: document.getElementById('autoStartBypassToggle') as HTMLInputElement,
  autoPickStrategyToggle: document.getElementById('autoPickStrategyToggle') as HTMLInputElement,
  minimizeToTrayToggle: document.getElementById('minimizeToTrayToggle') as HTMLInputElement,
  autoUpdateZapretToggle: document.getElementById('autoUpdateZapretToggle') as HTMLInputElement,
  bypassAutoRecoverToggle: document.getElementById('bypassAutoRecoverToggle') as HTMLInputElement,
  bypassAutoSwitchToggle: document.getElementById('bypassAutoSwitchToggle') as HTMLInputElement,
  backgroundRerankToggle: document.getElementById('backgroundRerankToggle') as HTMLInputElement,
  probeSitesInput: document.getElementById('probeSitesInput') as HTMLInputElement,
  gameModeToggle: document.getElementById('gameModeToggle') as HTMLInputElement,
  gameProcessesInput: document.getElementById('gameProcessesInput') as HTMLInputElement,
  bypassActivity: document.getElementById('bypassActivity')!,
  bypassHealthDot: document.getElementById('bypassHealthDot')!,
  bypassActivityText: document.getElementById('bypassActivityText')!,
  btnRecoverNow: document.getElementById('btnRecoverNow') as HTMLButtonElement,
  bypassHistoryList: document.getElementById('bypassHistoryList')!,
  btnSaveReport: document.getElementById('btnSaveReport') as HTMLButtonElement,
  quickBypassMeta: document.getElementById('quickBypassMeta')!,
  bypassStatusDot: document.getElementById('bypassStatusDot')!,
  bypassDeckTitle: document.getElementById('bypassDeckTitle')!,
  bypassDeckMeta: document.getElementById('bypassDeckMeta')!,
  btnBypassDeckToggle: document.getElementById('btnBypassDeckToggle') as HTMLButtonElement,
  btnVpnDeckToggle: document.getElementById('btnVpnDeckToggle') as HTMLButtonElement,
  quickTgMeta: document.getElementById('quickTgMeta')!,
  userListKind: document.getElementById('userListKind') as HTMLSelectElement,
  userListHint: document.getElementById('userListHint')!,
  userListEditor: document.getElementById('userListEditor') as HTMLTextAreaElement,
  userListChips: document.getElementById('userListChips') as HTMLUListElement,
  userListCount: document.getElementById('userListCount')!,
  userListQuickAdd: document.getElementById('userListQuickAdd') as HTMLInputElement,
  btnUserListAdd: document.getElementById('btnUserListAdd') as HTMLButtonElement,
  btnUserListSave: document.getElementById('btnUserListSave') as HTMLButtonElement,
  btnDiagnostics: document.getElementById('btnDiagnostics') as HTMLButtonElement,
  btnFindBest: document.getElementById('btnFindBest') as HTMLButtonElement,
  btnTests: document.getElementById('btnTests') as HTMLButtonElement,
  btnFullCheck: document.getElementById('btnFullCheck') as HTMLButtonElement,
  strategyPickBest: document.getElementById('strategyPickBest')!,
  strategyPickList: document.getElementById('strategyPickList')!,
  testProgressWrap: document.getElementById('testProgressWrap')!,
  testProgressBar: document.getElementById('testProgressBar')!,
  testProgressText: document.getElementById('testProgressText')!,
  testProgressPct: document.getElementById('testProgressPct')!,
  testResults: document.getElementById('testResults')!,
  btnProcessStatus: document.getElementById('btnProcessStatus') as HTMLButtonElement,
  btnCheckUpdates: document.getElementById('btnCheckUpdates') as HTMLButtonElement,
  btnFullRemove: document.getElementById('btnFullRemove') as HTMLButtonElement,
  btnClearLog: document.getElementById('btnClearLog') as HTMLButtonElement,
  btnCopyLog: document.getElementById('btnCopyLog') as HTMLButtonElement,
  log: document.getElementById('log')!,
  logPanel: document.getElementById('logPanel')!,
  pathActionsGroup: document.getElementById('pathActionsGroup')!,
  pathLockHint: document.getElementById('pathLockHint')!,
  runtimeSettingsGroup: document.getElementById('runtimeSettingsGroup')!,
  settingsLockHint: document.getElementById('settingsLockHint')!,
  userListsGroup: document.getElementById('userListsGroup')!,
  listsLockHint: document.getElementById('listsLockHint')!,
  configStrategyGroup: document.getElementById('configStrategyGroup')!,
  configTestsGroup: document.getElementById('configTestsGroup')!,
  configLockHint: document.getElementById('configLockHint')!,
  fullRemoveGroup: document.getElementById('fullRemoveGroup')!,
  strategyPickOverlay: document.getElementById('strategyPickOverlay')!,
  strategyPickTitle: document.getElementById('strategyPickTitle')!,
  strategyPickHint: document.getElementById('strategyPickHint')!,
  strategyPickProgressText: document.getElementById('strategyPickProgressText')!,
  strategyPickProgressPct: document.getElementById('strategyPickProgressPct')!,
  strategyPickProgressBar: document.getElementById('strategyPickProgressBar') as HTMLElement,
  strategyPickSpinner: document.getElementById('strategyPickSpinner')!,
  btnCancelStrategyPick: document.getElementById('btnCancelStrategyPick') as HTMLButtonElement,
  pageTitle: document.getElementById('pageTitle')!,
  pageSubtitle: document.getElementById('pageSubtitle')!,
  quickBypassCard: document.getElementById('quickBypassCard')!,
  quickBypassDot: document.getElementById('quickBypassDot')!,
  quickBypassText: document.getElementById('quickBypassText')!,
  btnQuickBypass: document.getElementById('btnQuickBypass') as HTMLButtonElement,
  quickTgCard: document.getElementById('quickTgCard')!,
  quickTgDot: document.getElementById('quickTgDot')!,
  quickTgText: document.getElementById('quickTgText')!,
  btnQuickTg: document.getElementById('btnQuickTg') as HTMLButtonElement,
  tgDeck: document.getElementById('tgDeck')!,
  tgStatusDot: document.getElementById('tgStatusDot')!,
  tgDeckTitle: document.getElementById('tgDeckTitle')!,
  tgDeckMeta: document.getElementById('tgDeckMeta')!,
  tgStatTotal: document.getElementById('tgStatTotal')!,
  tgStatActive: document.getElementById('tgStatActive')!,
  tgStatWs: document.getElementById('tgStatWs')!,
  tgStatTcp: document.getElementById('tgStatTcp')!,
  tgStatBad: document.getElementById('tgStatBad')!,
  btnTgToggle: document.getElementById('btnTgToggle') as HTMLButtonElement,
  btnTgDisconnect: document.getElementById('btnTgDisconnect') as HTMLButtonElement,
  tgPort: document.getElementById('tgPort') as HTMLInputElement,
  tgHost: document.getElementById('tgHost') as HTMLInputElement,
  tgSecret: document.getElementById('tgSecret') as HTMLInputElement,
  btnTgGenSecret: document.getElementById('btnTgGenSecret') as HTMLButtonElement,
  btnTgCopyLink: document.getElementById('btnTgCopyLink') as HTMLButtonElement,
  btnTgOpenTg: document.getElementById('btnTgOpenTg') as HTMLButtonElement,
  tgProxyLink: document.getElementById('tgProxyLink') as HTMLInputElement,
  tgAutostart: document.getElementById('tgAutostart') as HTMLInputElement,
  btnTgSaveConfig: document.getElementById('btnTgSaveConfig') as HTMLButtonElement,
  quickVpnCard: document.getElementById('quickVpnCard')!,
  quickVpnDot: document.getElementById('quickVpnDot')!,
  quickVpnText: document.getElementById('quickVpnText')!,
  quickVpnMeta: document.getElementById('quickVpnMeta')!,
  btnQuickVpn: document.getElementById('btnQuickVpn') as HTMLButtonElement,
  vpnStatusDot: document.getElementById('vpnStatusDot')!,
  vpnDeckTitle: document.getElementById('vpnDeckTitle')!,
  vpnDeckMeta: document.getElementById('vpnDeckMeta')!,
  vpnStatHandshake: document.getElementById('vpnStatHandshake')!,
  vpnStatRx: document.getElementById('vpnStatRx')!,
  vpnStatTx: document.getElementById('vpnStatTx')!,
  vpnEndpoint: document.getElementById('vpnEndpoint')!,
  vpnObfuscation: document.getElementById('vpnObfuscation')!,
  vpnAddress: document.getElementById('vpnAddress')!,
  vpnConfigText: document.getElementById('vpnConfigText') as HTMLTextAreaElement,
  btnVpnImportFile: document.getElementById('btnVpnImportFile') as HTMLButtonElement,
  btnVpnSaveText: document.getElementById('btnVpnSaveText') as HTMLButtonElement,
  btnVpnRemoveConfig: document.getElementById('btnVpnRemoveConfig') as HTMLButtonElement,
  vpnAutostart: document.getElementById('vpnAutostart') as HTMLInputElement,
  vpnGenEndpoint: document.getElementById('vpnGenEndpoint') as HTMLSelectElement,
  vpnGenPreset: document.getElementById('vpnGenPreset') as HTMLSelectElement,
  btnVpnGenerate: document.getElementById('btnVpnGenerate') as HTMLButtonElement,
  btnVpnExport: document.getElementById('btnVpnExport') as HTMLButtonElement,
  vpnCloudHelp: document.getElementById('vpnCloudHelp') as HTMLDetailsElement,
  btnVpnCloudOpen: document.getElementById('btnVpnCloudOpen') as HTMLButtonElement,
  btnVpnCloudImport: document.getElementById('btnVpnCloudImport') as HTMLButtonElement,
  btnCheckAccess: document.getElementById('btnCheckAccess') as HTMLButtonElement,
  accessMeta: document.getElementById('accessMeta')!,
  accessGrid: document.getElementById('accessGrid')!,
};

let currentStatus: StatusPayload | null = null;
let busy = false;
let strategyPickActive = false;
let isAdminUser = false;
let lastTestBest: StrategyRanking | null = null;
let testQuietMode = false;
let pickTimings: number[] = [];
let pickBestSoFar: { strategy: string; pct: number } | null = null;
let bootstrapKickStarted = false;
let lastBootstrapLogKey = '';
let autoStartBlockedNotified = false;
let strategyCustomSelect: CustomSelectHandle | null = null;
let gameFilterCustomSelect: CustomSelectHandle | null = null;
let ipsetCustomSelect: CustomSelectHandle | null = null;
let userListCustomSelect: CustomSelectHandle | null = null;
let userListsCache: Record<UserListKind, string> | null = null;
let lastStatusRenderKey = '';
let lastStrategiesKey = '';
let lastSettingsKey = '';
let statusPollTimer: number | null = null;
let appWindowVisible = true;

const POLL_VISIBLE_MS = 30_000;
let statusRefreshInFlight = false;
let statusRefreshQueued = false;
let pendingAppUpdateInfo: AppUpdateInfo | null = null;
let appUpdateInProgress = false;

let tgwsConfig: TgwsProxyConfig | null = null;
let tgwsRunning = false;
let tgwsStats: TgwsProxyStats = { total: 0, active: 0, ws: 0, tcp: 0, bad: 0 };
let tgwsPollTimer: number | null = null;
let tgConfigDirty = false;
let vpnState: VpnState | null = null;
let vpnBusy = false;
let vpnProgressText: string | null = null;
let vpnEndpointSelect: CustomSelectHandle | null = null;
let vpnPresetSelect: CustomSelectHandle | null = null;

async function refreshAdminState(): Promise<void> {
  try {
    isAdminUser = await api.isAdmin();
    els.adminBanner.classList.toggle('hidden', isAdminUser);
  } catch {
    isAdminUser = false;
    els.adminBanner.classList.remove('hidden');
  }
  updateControls(currentStatus);
}

function log(message: string, type: JournalLevel = 'info'): void {
  appendJournalLine(message, type);
}

function formatConfigCount(count: number): string {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod100 >= 11 && mod100 <= 14) return `${count} конфигов`;
  if (mod10 === 1) return `${count} конфиг`;
  if (mod10 >= 2 && mod10 <= 4) return `${count} конфига`;
  return `${count} конфигов`;
}

function resetTestUi(): void {
  setInlineTestProgress({ visible: false });
  els.testProgressBar.style.width = '0%';
  els.testResults.classList.add('hidden');
  els.testResults.innerHTML = '';
  lastTestBest = null;
}

function formatDuration(ms: number): string {
  const sec = Math.max(1, Math.round(ms / 1000));
  if (sec < 60) return `${sec} с`;
  const min = Math.floor(sec / 60);
  const rest = sec % 60;
  return rest ? `${min} мин ${rest} с` : `${min} мин`;
}

function showTestProgress(current: number, total: number, strategy: string): void {
  const done = current - 1;
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  let label = `${current} из ${total} · ${strategy.replace('.bat', '')}`;
  if (pickTimings.length > 0 && total > 1) {
    const avg = pickTimings.reduce((sum, ms) => sum + ms, 0) / pickTimings.length;
    label += ` · осталось ~${formatDuration(avg * (total - done))}`;
  }

  if (strategyPickActive) {
    setPickProgress({ visible: true, percent: Math.max(pct, 2), label });
  } else {
    setInlineTestProgress({ visible: true, percent: Math.max(pct, 2), label });
  }

  setJournalStatus(`Проверка ${current} из ${total}`);
}

function pctTone(pct: number): 'good' | 'mid' | 'low' {
  return pct >= 70 ? 'good' : pct >= 40 ? 'mid' : 'low';
}

function addPickLiveRow(data: { strategy: string; pct: number; failed?: string[] }): void {
  if (!strategyPickActive) return;
  const name = data.strategy.replace('.bat', '');
  const li = document.createElement('li');
  li.className = `pick-row pick-${pctTone(data.pct)}`;
  li.innerHTML = `<span class="pick-row-name">${escapeHtml(name)}</span>${renderTestPctBar(data.pct)}`;
  if (data.failed?.length) li.title = `Не открылось: ${data.failed.join(', ')}`;
  els.strategyPickList.prepend(li);

  if (!pickBestSoFar || data.pct > pickBestSoFar.pct) {
    pickBestSoFar = { strategy: data.strategy, pct: data.pct };
    els.strategyPickBest.classList.remove('hidden');
    els.strategyPickBest.innerHTML = `<span>Лучший пока</span><strong>${escapeHtml(name)}</strong><em>${data.pct}%</em>`;
  }
  els.btnCancelStrategyPick.textContent = 'Остановить и показать результаты';
}

function openStrategyPickOverlay(auto: boolean, quick: boolean): void {
  els.strategyPickTitle.textContent = auto ? 'Автоподбор конфига' : quick ? 'Подбор конфига' : 'Проверка всех конфигов';
  els.strategyPickHint.textContent = quick
    ? 'Проверяем конфиги по очереди и останавливаемся на первом, который открыл всё.'
    : 'Проверяем каждый конфиг. Можно остановить в любой момент — проверенные останутся в таблице.';
  pickTimings = [];
  pickBestSoFar = null;
  els.strategyPickList.innerHTML = '';
  els.strategyPickBest.classList.add('hidden');
  els.btnCancelStrategyPick.textContent = 'Отменить';
  els.btnCancelStrategyPick.disabled = false;
  setPickProgress({ visible: true, percent: 0, label: 'Подготовка...' });
  els.strategyPickOverlay.classList.remove('hidden');
  requestAnimationFrame(() => els.strategyPickOverlay.classList.add('is-open'));
  document.body.classList.add('strategy-pick-active');
}

function closeStrategyPickOverlay(): void {
  els.strategyPickOverlay.classList.remove('is-open');
  els.strategyPickOverlay.classList.add('hidden');
  document.body.classList.remove('strategy-pick-active');
}

function setStrategyPickActive(active: boolean): void {
  strategyPickActive = active;
  updateControls(currentStatus);
  syncCustomSelectsDisabled(currentStatus);
}

/**
 * Проверки сами запускают и гасят winws, поэтому работающий обход
 * останавливаем перед ними и поднимаем обратно после (уже с новым конфигом).
 */
async function pauseBypassForTests(): Promise<boolean | null> {
  if (!currentStatus?.bypass.running) return false;
  const ok = await confirmModal(
    'Обход будет перезапущен',
    'На время проверки обход выключится, интернет через zapret пропадёт на минуту-другую.',
    'После проверки обход запустится снова — уже с выбранным конфигом.'
  );
  if (!ok) return null;
  log('Останавливаю обход на время проверки...', 'info');
  await api.stopBypass();
  return true;
}

async function resumeBypassAfterTests(): Promise<void> {
  try {
    await api.startBypass();
    log('Обход снова запущен', 'success');
  } catch (err) {
    reportFailure(err, 'Не удалось запустить обход');
  }
}

async function runPickBestStrategy(options: { auto?: boolean; quick?: boolean } = {}): Promise<void> {
  if (strategyPickActive) return;
  if (busy) {
    hintBusy();
    return;
  }
  const quick = options.auto ? true : !!options.quick;

  const paused = options.auto ? false : await pauseBypassForTests();
  if (paused === null) return;

  setBusy(true, 'Подбор конфига');
  setStrategyPickActive(true);
  openStrategyPickOverlay(!!options.auto, quick);
  resetTestUi();
  testQuietMode = true;
  clearJournal();
  setJournalTitle(options.auto ? 'Автоподбор конфига' : quick ? 'Подбор конфига' : 'Проверка всех конфигов');
  setJournalStatus('Запуск...');

  try {
    const result = await api.runPickBestStrategy({ quick });
    if (result.cancelled) {
      if (result.partialBest) {
        toast('Подбор остановлен — выберите конфиг в таблице результатов', 'info');
        setActiveAppView('bypass');
      } else {
        toast('Подбор конфига отменён', 'info');
      }
      log('Подбор конфига остановлен', 'info');
      setJournalStatus('Остановлено');
    } else if (result.strategy) {
      const name = result.strategy.replace('.bat', '');
      const pct =
        result.totalChecks > 0 ? Math.round((result.okChecks / result.totalChecks) * 100) : 0;
      toast(`Выбран конфиг: ${name}${result.totalChecks > 0 ? ` — ${pct}%` : ''}`, 'success');
      log(`Выбран конфиг: ${name}`, 'success');
      setJournalStatus('Готово');
    } else {
      setJournalStatus('Конфиг по умолчанию');
    }
    if (paused) await resumeBypassAfterTests();
    lastStatusRenderKey = '';
    await refreshStatus();
    markCurrentInResults();
  } catch (err) {
    reportFailure(err);
    setJournalStatus('Ошибка');
    if (paused) await resumeBypassAfterTests();
  } finally {
    testQuietMode = false;
    closeStrategyPickOverlay();
    setStrategyPickActive(false);
    setBusy(false);
    if (options.auto) {
      try {
        await api.completePostBootstrap();
      } catch {
        /* ignore */
      }
    }
  }
}

async function runCurrentStrategyTest(): Promise<void> {
  if (busy || strategyPickActive) return;
  const paused = await pauseBypassForTests();
  if (paused === null) return;
  await runTool('Тест текущего конфига', () => api.runTests('current'), { isTest: true });
  if (paused) {
    await resumeBypassAfterTests();
    void refreshStatus();
  }
}

async function maybeStartAutoPick(): Promise<void> {
  if (strategyPickActive) return;
  try {
    const { pending } = await api.getAutoPickPending();
    if (pending) {
      await runPickBestStrategy({ auto: true });
    }
  } catch {
    /* автоподбор необязателен */
  }
}

function renderTestPctBar(pct: number): string {
  return `<span class="test-pct"><span class="test-pct-track"><span class="test-pct-fill test-pct-${pctTone(pct)}" style="width:${pct}%"></span></span><span class="test-pct-val">${pct}%</span></span>`;
}

function formatTestDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

function rankingPct(row: StrategyRanking): number {
  return row.maxScore > 0 ? Math.round((row.score / row.maxScore) * 100) : 0;
}

function renderTestResults(payload: TestResultPayload, at?: string): void {
  if (!payload.best) return;
  lastTestBest = payload.best;
  els.testResults.classList.remove('hidden');

  const bestPct = rankingPct(payload.best);
  const bestName = payload.best.strategy.replace('.bat', '');
  const kind = payload.rankings.length === 1 ? 'Тест конфига' : payload.quick ? 'Быстрый подбор' : 'Полная проверка';
  const meta = [kind, payload.cancelled ? 'остановлена' : '', at ? formatTestDate(at) : 'только что']
    .filter(Boolean)
    .join(' · ');
  const failedHint = payload.best.failed?.length
    ? `<span class="test-best-failed">Не открылось: ${escapeHtml(payload.best.failed.join(', '))}</span>`
    : '';

  let html = `<p class="test-meta">${escapeHtml(meta)}</p>
  <div class="test-best">
    <div class="test-best-copy">
      <span class="test-best-label">Лучший конфиг</span>
      <strong>${escapeHtml(bestName)}</strong>
      <span class="test-best-score">${bestPct}% · ${payload.best.okChecks}/${payload.best.totalChecks} проверок</span>
      ${failedHint}
    </div>
    <button class="btn btn-glow test-apply-btn" type="button" data-strategy="${escapeHtml(payload.best.strategy)}">Применить</button>
  </div>`;

  if (payload.rankings.length > 1) {
    html += '<p class="test-table-hint">Нажмите на строку, чтобы выбрать другой конфиг</p>';
    html += '<div class="test-table-wrap"><div class="test-table">';
    html += '<div class="test-row test-head"><span>#</span><span>Конфиг</span><span>Результат</span></div>';
    payload.rankings.forEach((row, index) => {
      const isBest = row.strategy === payload.best?.strategy;
      const failed = row.failed?.length ? ` title="Не открылось: ${escapeHtml(row.failed.join(', '))}"` : '';
      html += `<button class="test-row test-row-btn${isBest ? ' test-row-best' : ''}" type="button" data-strategy="${escapeHtml(row.strategy)}"${failed}>
      <span>${index + 1}</span>
      <span class="test-row-name">${escapeHtml(row.strategy.replace('.bat', ''))}<em class="test-current-badge">текущий</em></span>
      ${renderTestPctBar(rankingPct(row))}
    </button>`;
    });
    html += '</div></div>';
  }

  els.testResults.innerHTML = html;
  markCurrentInResults();
}

/** Отмечает в таблице конфиг, который сейчас выбран. */
function markCurrentInResults(): void {
  const current = currentStatus?.selectedStrategy ?? null;
  els.testResults.querySelectorAll<HTMLElement>('[data-strategy]').forEach((el) => {
    const isCurrent = el.dataset.strategy === current;
    el.classList.toggle('is-current', isCurrent);
    if (el.classList.contains('test-apply-btn')) {
      (el as HTMLButtonElement).disabled = isCurrent;
      el.textContent = isCurrent ? 'Используется' : 'Применить';
    }
  });
}

async function loadLastTestResults(): Promise<void> {
  try {
    const last = await api.getLastTestResults();
    if (last && els.testResults.classList.contains('hidden')) renderTestResults(last, last.at);
  } catch {
    /* нет сохранённых результатов */
  }
}

async function applyStrategy(name: string): Promise<void> {
  if (busy) {
    hintBusy();
    return;
  }
  await runAction('Стратегия', () => api.setStrategy(name));
  els.strategySelect.value = name;
  toast(`Конфиг: ${name.replace('.bat', '')}`, 'success');
  if (currentStatus) {
    renderStatus({ ...currentStatus, selectedStrategy: name }, els.zapretPath.textContent || '');
  }
}

function reportFailure(err: unknown, title?: string): void {
  const message = formatUserError(err);
  log(message, 'error');
  showErrorModal(err, title);
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function updateAdminHint(status: StatusPayload | null): void {
  const needsAdmin = !!status?.pathsValid && !isAdminUser;
  els.btnToggle.title = needsAdmin
    ? 'Нужны права администратора — запустите приложение от имени администратора'
    : '';
  els.powerZone.title = needsAdmin ? 'Нужны права администратора' : '';
}

function setRuntimeLock(locked: boolean): void {
  const groups = [
    els.pathActionsGroup,
    els.userListsGroup,
    els.configStrategyGroup,
    els.fullRemoveGroup,
  ];
  for (const group of groups) {
    group.classList.toggle('runtime-locked', locked);
  }
  els.pathLockHint.classList.toggle('hidden', !locked);
  // фильтры меняются и на ходу: Skvoz сам перезапускает обход
  els.settingsLockHint.classList.add('hidden');
  els.listsLockHint.classList.toggle('hidden', !locked);
  els.updatesLockHint.classList.toggle('hidden', !locked);
  els.configLockHint.classList.toggle('hidden', !locked);
}

function updateControls(status: StatusPayload | null): void {
  const hasPath = !!status?.pathsValid;
  const running = !!status?.bypass.running;
  const canStart = hasPath && (status?.strategies.length ?? 0) > 0 && isAdminUser;
  const runningLocked = running && hasPath;
  const pickLocked = strategyPickActive;

  setRuntimeLock(runningLocked);

  const pathButtons = new Set([
    'btnRescan',
    'btnRescanEmpty',
    'btnChangePath',
    'btnChangePathEmpty',
    'btnDownload',
    'btnDownloadInline',
  ]);

  const configButtons = new Set(['btnFindBest', 'btnFullCheck', 'btnTests']);

  for (const id of ACTION_BUTTON_IDS) {
    const el = document.getElementById(id);
    if (!(el instanceof HTMLButtonElement)) continue;

    if (id === 'btnToggle') {
      el.disabled = pickLocked || (running ? !hasPath : !canStart);
      el.classList.toggle('is-busy', busy && !pickLocked);
      continue;
    }

    if (pathButtons.has(id)) {
      el.disabled = pickLocked || busy || runningLocked;
      continue;
    }

    if (configButtons.has(id)) {
      el.disabled = pickLocked || busy || !hasPath || !isAdminUser;
      continue;
    }

    if (id === 'btnFullRemove') {
      el.disabled = pickLocked || busy || !isAdminUser || runningLocked;
      continue;
    }

    if (id === 'btnDiagnostics' || id === 'btnProcessStatus' || id === 'btnCheckUpdates') {
      el.disabled = pickLocked || busy || !hasPath;
      continue;
    }

    if (id === 'btnClearLog' || id === 'btnCopyLog') {
      el.disabled = pickLocked || busy;
      continue;
    }

    el.disabled = pickLocked || busy;
  }

  els.strategySelect.disabled = pickLocked || busy || !hasPath || runningLocked;
  els.gameFilterSelect.disabled = pickLocked || busy || !hasPath;
  els.ipsetToggle.disabled = pickLocked || busy || !hasPath;
  els.ipsetModeSelect.disabled = pickLocked || busy || !hasPath;
  els.btnUpdateIpset.disabled = pickLocked || busy || !hasPath || runningLocked;
  els.btnUpdateHosts.disabled = pickLocked || busy || !hasPath;
  els.btnRemoveServices.disabled = pickLocked || busy || !isAdminUser;
  els.userListKind.disabled = pickLocked || busy || !hasPath || runningLocked;
  els.userListEditor.disabled = pickLocked || busy || !hasPath || runningLocked;
  els.userListQuickAdd.disabled = pickLocked || busy || !hasPath || runningLocked;
  els.btnUserListAdd.disabled = pickLocked || busy || !hasPath || runningLocked;
  els.btnUserListSave.disabled = pickLocked || busy || !hasPath || runningLocked;
  els.userListChips.querySelectorAll<HTMLButtonElement>('button').forEach((button) => {
    button.disabled = els.userListQuickAdd.disabled;
  });
  els.checkUpdatesToggle.disabled = pickLocked || busy || !hasPath || runningLocked;
  els.launchAtStartupToggle.disabled = pickLocked;
  els.autoStartBypassToggle.disabled = pickLocked;
  els.autoPickStrategyToggle.disabled = pickLocked;
  els.minimizeToTrayToggle.disabled = pickLocked;
  els.autoUpdateZapretToggle.disabled = pickLocked;
  els.bypassAutoRecoverToggle.disabled = pickLocked;
  // переключение работает только внутри автовосстановления
  els.bypassAutoSwitchToggle.disabled = pickLocked || !els.bypassAutoRecoverToggle.checked;
  els.backgroundRerankToggle.disabled = pickLocked;
  els.gameModeToggle.disabled = pickLocked;
  els.gameProcessesInput.disabled = pickLocked || !els.gameModeToggle.checked;
  els.btnRestartAdmin.disabled = pickLocked || busy;
  els.btnCancelStrategyPick.disabled = !pickLocked;
  els.btnQuickBypass.disabled = pickLocked || busy || (hasPath && (running ? false : !canStart));
  els.btnQuickBypass.textContent = !hasPath ? 'Установить zapret' : running ? 'Выключить' : 'Включить';
  els.btnBypassDeckToggle.disabled = els.btnQuickBypass.disabled;
  document.querySelectorAll<HTMLButtonElement>('[data-install-zapret]').forEach((button) => {
    button.disabled = pickLocked || busy;
  });
  els.btnBypassDeckToggle.textContent = running ? 'Выключить' : 'Включить';
  els.btnBypassDeckToggle.classList.toggle('btn-glow', !running);
  els.btnBypassDeckToggle.classList.toggle('btn-soft', running);
  els.btnQuickTg.disabled = pickLocked || busy;
  els.btnTgToggle.disabled = els.btnQuickTg.disabled;
  els.btnQuickVpn.disabled = pickLocked || vpnBusy;
  els.btnVpnDeckToggle.disabled = els.btnQuickVpn.disabled;
  updateAdminHint(status);
}

function updateQuickBypass(status: StatusPayload | null): void {
  const running = !!status?.bypass.running;
  const ready = !!status?.pathsValid;
  els.quickBypassCard.classList.toggle('is-live', running);
  els.quickBypassCard.classList.toggle('is-unavailable', !ready);
  els.quickBypassDot.classList.toggle('is-live', running);
  els.quickBypassText.textContent = running ? 'Включён' : ready ? 'Выключен' : 'Zapret не установлен';
  const strategy = status?.selectedStrategy?.replace(/\.bat$/i, '');
  els.quickBypassMeta.textContent = ready && strategy ? `Конфиг: ${strategy}` : '';

  els.bypassStatusDot.classList.toggle('is-live', running);
  els.bypassDeckTitle.textContent = running ? 'Обход включён' : 'Обход выключен';
  els.bypassDeckMeta.textContent = running
    ? `Конфиг: ${strategy ?? '—'}`
    : strategy
      ? `Включится с конфигом ${strategy}`
      : 'Выберите конфиг ниже';
}

let busyLabel = '';
let busyHintAt = 0;

/** Клик во время другой операции раньше молча терялся — теперь говорим, чего ждём */
function hintBusy(): void {
  const now = Date.now();
  if (now - busyHintAt < 1500) return;
  busyHintAt = now;
  toast(busyLabel ? `Подождите, идёт: ${busyLabel.toLowerCase()}` : 'Подождите, идёт другая операция', 'info');
}

function setBusy(value: boolean, label = ''): void {
  busy = value;
  busyLabel = value ? label : '';
  setActionBusy(value);
  updateControls(currentStatus);
  syncCustomSelectsDisabled(currentStatus);
}

function syncCustomSelectsDisabled(status: StatusPayload | null): void {
  const hasPath = !!status?.pathsValid;
  const runningLocked = !!status?.bypass.running && hasPath;
  const disabled = strategyPickActive || busy || !hasPath || runningLocked;
  strategyCustomSelect?.setDisabled(disabled);
  // фильтры меняются и при работающем обходе — его перезапустят
  const filtersDisabled = strategyPickActive || busy || !hasPath;
  gameFilterCustomSelect?.setDisabled(filtersDisabled);
  ipsetCustomSelect?.setDisabled(filtersDisabled);
  userListCustomSelect?.setDisabled(disabled);
}

function currentUserListKind(): UserListKind {
  const value = els.userListKind.value;
  if (value === 'exclude-domains' || value === 'exclude-ips') return value;
  return 'general';
}

/** Заглушки, которые zapret кладёт в пустые списки, — пользователю их не показываем. */
const USER_LIST_PLACEHOLDERS = new Set(['domain.example.abc', '203.0.113.113/32']);

function userListEntries(raw: string): string[] {
  const seen = new Set<string>();
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => {
      const key = line.toLowerCase();
      if (!line || line.startsWith('#') || USER_LIST_PLACEHOLDERS.has(key) || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function renderUserListChips(kind: UserListKind, highlight: string[] = []): void {
  const entries = userListEntries(userListsCache?.[kind] ?? '');
  const fresh = new Set(highlight.map((entry) => entry.toLowerCase()));
  els.userListCount.textContent = `Добавлено: ${entries.length}`;
  els.userListChips.replaceChildren();

  if (entries.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'user-list-empty';
    empty.textContent = 'Пока ничего не добавлено';
    els.userListChips.append(empty);
    return;
  }

  // Новые сверху, чтобы только что добавленное было видно сразу
  for (const entry of [...entries].reverse()) {
    const chip = document.createElement('li');
    chip.className = 'user-list-chip';
    if (fresh.has(entry.toLowerCase())) chip.classList.add('is-new');
    const text = document.createElement('span');
    text.textContent = entry;
    text.title = entry;
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'user-list-chip-remove';
    remove.textContent = '×';
    remove.title = `Удалить ${entry}`;
    remove.setAttribute('aria-label', `Удалить ${entry}`);
    remove.disabled = els.userListQuickAdd.disabled;
    remove.addEventListener('click', () => void removeUserListEntry(kind, entry));
    chip.append(text, remove);
    els.userListChips.append(chip);
  }
}

async function removeUserListEntry(kind: UserListKind, entry: string): Promise<void> {
  if (busy || !currentStatus?.pathsValid || !userListsCache) return;
  const remaining = userListEntries(userListsCache[kind]).filter((line) => line.toLowerCase() !== entry.toLowerCase());
  setBusy(true, 'Сохранение списка');
  try {
    const result = await api.saveUserList(kind, remaining.join('\n'));
    userListsCache = result.lists;
    applyUserListEditor(kind);
    toast(`Удалено: ${entry}`, 'info');
    userListApplyHint(!!currentStatus.bypass.running);
  } catch (err) {
    reportFailure(err);
  } finally {
    setBusy(false);
  }
}

function applyUserListEditor(kind: UserListKind, highlight: string[] = []): void {
  els.userListHint.textContent = USER_LIST_HINTS[kind];
  els.userListEditor.value = userListEntries(userListsCache?.[kind] ?? '').join('\n');
  renderUserListChips(kind, highlight);
  els.userListQuickAdd.placeholder =
    kind === 'exclude-ips' ? '192.168.0.0/24' : 'example.com или 1.2.3.4';
}

async function loadUserLists(force = false): Promise<void> {
  if (!currentStatus?.pathsValid) {
    userListsCache = null;
    els.userListEditor.value = '';
    renderUserListChips(currentUserListKind());
    return;
  }
  if (userListsCache && !force) {
    applyUserListEditor(currentUserListKind());
    return;
  }
  try {
    const payload = await api.getUserLists();
    userListsCache = payload.lists;
    applyUserListEditor(currentUserListKind());
  } catch (err) {
    log(formatUserError(err), 'error');
  }
}

function userListApplyHint(running: boolean): void {
  if (!running) return;
  toast('Перезапустите обход, чтобы применить списки', 'info');
}

async function saveUserListFromEditor(): Promise<void> {
  if (busy) {
    hintBusy();
    return;
  }
  if (!currentStatus?.pathsValid) return;
  const kind = currentUserListKind();
  setBusy(true, 'Сохранение списка');
  try {
    const result = await api.saveUserList(kind, els.userListEditor.value);
    userListsCache = result.lists;
    applyUserListEditor(kind);
    toast('Список сохранён', 'success');
    userListApplyHint(!!currentStatus.bypass.running);
  } catch (err) {
    reportFailure(err);
  } finally {
    setBusy(false);
  }
}

async function addUserListQuick(): Promise<void> {
  if (busy) {
    hintBusy();
    return;
  }
  if (!currentStatus?.pathsValid) return;
  const entry = els.userListQuickAdd.value.trim();
  if (!entry) return;

  const kind = currentUserListKind();
  setBusy(true, 'Сохранение списка');
  try {
    const result = await api.addUserListEntries(kind, [entry]);
    userListsCache = result.lists;
    applyUserListEditor(kind, result.added);
    els.userListQuickAdd.value = '';

    if (result.added.length > 0) {
      toast(`Добавлено: ${result.added[0]}`, 'success');
      userListApplyHint(!!currentStatus.bypass.running);
    } else if (result.skipped.length > 0) {
      toast('Уже есть в списке', 'info');
      applyUserListEditor(kind, result.skipped);
    }
  } catch (err) {
    reportFailure(err);
  } finally {
    setBusy(false);
  }
}

function setTag(el: HTMLElement, text: string, variant: 'ok' | 'warn' | 'bad' | 'muted'): void {
  el.textContent = text;
  el.className =
    variant === 'muted' ? 'pill pill-muted' : `pill${variant === 'ok' ? '' : ` ${variant}`}`;
}

function showBootstrapBanner(message: string, visible = true): void {
  if (!visible) {
    els.bootstrapBanner.classList.add('hidden');
    els.bootstrapBanner.classList.remove('notice-loading');
    return;
  }
  els.bootstrapBanner.textContent = message;
  els.bootstrapBanner.classList.remove('hidden');
  els.bootstrapBanner.style.animation = 'none';
  requestAnimationFrame(() => {
    els.bootstrapBanner.style.animation = '';
  });
}

function showAppUpdateBanner(info: AppUpdateInfo | null): void {
  if (!info || info.upToDate || !info.latest) {
    pendingAppUpdateInfo = null;
    els.appUpdateBanner.classList.add('hidden');
    return;
  }

  pendingAppUpdateInfo = info;
  els.appUpdateBannerText.textContent = `v${info.current} → v${info.latest}`;
  els.appUpdateBanner.classList.remove('hidden');
}

async function refreshAppVersionLine(): Promise<void> {
  try {
    const version = await api.getAppVersion();
    els.appVersionLine.textContent = `Версия ${version}`;
    els.updAppVersion.textContent = `Skvoz v${version}`;
  } catch {
    els.appVersionLine.textContent = '';
  }
}

async function installAppUpdate(): Promise<void> {
  if (busy || appUpdateInProgress || !pendingAppUpdateInfo?.latest) return;

  const latest = pendingAppUpdateInfo.latest;
  setBusy(true, 'Обновление Skvoz');
  appUpdateInProgress = true;
  els.btnInstallAppUpdate.textContent = 'Скачиваем…';
  setGlobalLoad({
    visible: true,
    title: 'Обновление Skvoz',
    message: `Скачиваем версию ${latest}…`,
    indeterminate: true,
    stage: 'download',
  });

  try {
    log(`Загрузка Skvoz ${latest}...`, 'info');
    await api.downloadAppUpdate();
    els.btnInstallAppUpdate.textContent = 'Устанавливаем…';
    setGlobalLoad({
      visible: true,
      title: 'Устанавливаем Skvoz ' + latest,
      message: 'Приложение закроется и через несколько секунд откроется уже обновлённым',
      percent: 100,
      stage: 'done',
    });
    log(`Skvoz ${latest} скачан, устанавливаем...`, 'success');
    await api.applyAppUpdate();
  } catch (err) {
    appUpdateInProgress = false;
    els.btnInstallAppUpdate.textContent = 'Повторить';
    setGlobalLoad({ visible: false });
    reportFailure(err, 'Не удалось обновить Skvoz');
    setBusy(false);
  }
}

function showOfficialWarning(status: StatusPayload, bootstrap?: BootstrapState | null): void {
  const warnings = [...(bootstrap?.warnings ?? []), ...status.officialWarnings];
  const unofficial = !status.isOfficial || warnings.some((w) => w.toLowerCase().includes('неофици'));

  // пока zapret не установлен, предупреждать не о чем
  if (!status.pathsValid || (!unofficial && bootstrap?.autoFixed !== true)) {
    els.officialWarning.classList.add('hidden');
    return;
  }

  els.officialWarning.innerHTML = `<strong>Предупреждение</strong>${
    bootstrap?.autoFixed ? 'Неофициальная сборка заменена. ' : ''
  }Официальный zapret: github.com/Flowseal/zapret-discord-youtube`;
  els.officialWarning.classList.remove('hidden');
}

function setDownloadingUi(active: boolean, message?: string): void {
  els.emptyStateTitle.textContent = active ? 'Установка zapret...' : 'Zapret не установлен';
  els.emptyStateHint.textContent =
    message ??
    (active
      ? 'Это может занять минуту.'
      : 'Нажмите «Установить zapret». Если он уже есть на компьютере, найдите его или укажите папку.');
  els.emptyStateActions.classList.toggle('hidden', active);
  setHeroLoading(active);
  els.btnDownload.disabled = active || busy;
  els.btnRescanEmpty.disabled = active || busy;
  els.btnChangePathEmpty.disabled = active || busy;
}

let globalLoadHideTimer: number | null = null;

function cancelGlobalLoadHide(): void {
  if (globalLoadHideTimer !== null) {
    window.clearTimeout(globalLoadHideTimer);
    globalLoadHideTimer = null;
  }
}

/** Скрыть карточку загрузки, если за это время не началась новая */
function scheduleGlobalLoadHide(ms: number): void {
  cancelGlobalLoadHide();
  globalLoadHideTimer = window.setTimeout(() => {
    globalLoadHideTimer = null;
    setGlobalLoad({ visible: false });
  }, ms);
}

function showDownloadProgress(progress: DownloadProgress): void {
  const stage = mapDownloadStage(progress.stage);
  if (appUpdateInProgress) {
    // Это загрузка самого Skvoz — zapret и статус не трогаем
    if (progress.stage === 'done' || progress.stage === 'error') return;
    setGlobalLoad({
      visible: true,
      title: 'Обновление Skvoz',
      message: progress.message,
      percent: progress.percent,
      stage: 'download',
      indeterminate: progress.percent < 1,
    });
    return;
  }
  // Фоновое автообновление: прогресс видно, но работать с приложением можно
  const blocking = !progress.background;
  if (!currentStatus?.pathsValid) {
    setDownloadingUi(true, progress.message);
  }

  if (progress.stage === 'done') {
    setGlobalLoad({
      visible: true,
      title: progress.background ? 'Zapret обновлён' : 'Zapret установлен',
      message: progress.message,
      percent: 100,
      stage: 'done',
    });
    scheduleGlobalLoadHide(1400);
    setHeroLoading(false);
    setDownloadingUi(false);
    if (!progress.background) els.statusText.textContent = 'Готово';
    return;
  }

  if (progress.stage === 'error') {
    setGlobalLoad({
      visible: true,
      title: progress.background ? 'Автообновление zapret не удалось' : 'Ошибка загрузки',
      message: progress.message,
      stage: 'error',
    });
    // текст ошибки остаётся в журнале и баннере — карточку убираем, чтобы не висела
    scheduleGlobalLoadHide(8000);
    setHeroLoading(false);
    setDownloadingUi(false, progress.message);
    if (!progress.background) els.statusText.textContent = 'Ошибка';
    return;
  }

  cancelGlobalLoadHide();
  setGlobalLoad({
    visible: true,
    title: progress.background ? 'Обновление zapret' : stage === 'scan' ? 'Поиск zapret' : 'Загрузка zapret',
    message: progress.message,
    percent: progress.percent,
    stage,
    indeterminate: stage === 'scan' && progress.percent < 1,
    blocking,
  });

  if (!currentStatus?.pathsValid) {
    els.statusText.textContent = stage === 'scan' ? 'Поиск...' : 'Загрузка...';
  }
}

let lastLayoutMissing: boolean | null = null;

function playPanelEnter(...elements: HTMLElement[]): void {
  for (const el of elements) {
    el.classList.remove('panel-enter');
    void el.offsetWidth;
    el.classList.add('panel-enter');
    el.addEventListener('animationend', () => el.classList.remove('panel-enter'), { once: true });
  }
}

let lastPowerRunning: boolean | null = null;

function flashPowerState(): void {
  els.btnToggleIcon.classList.remove('power-icon-pop');
  els.btnToggleText.classList.remove('power-label-fade');
  void els.btnToggleIcon.offsetWidth;
  els.btnToggleIcon.classList.add('power-icon-pop');
  els.btnToggleText.classList.add('power-label-fade');

  const cleanup = (): void => {
    els.btnToggleIcon.classList.remove('power-icon-pop');
    els.btnToggleText.classList.remove('power-label-fade');
  };
  els.btnToggleText.addEventListener('animationend', cleanup, { once: true });
}

function updatePowerButton(running: boolean, animate = false): void {
  els.powerZone.classList.toggle('is-running', running);

  const nextIcon = running ? '■' : '▶';
  const nextLabel = running ? 'Стоп' : 'Старт';
  const stateChanged = lastPowerRunning !== null && lastPowerRunning !== running;
  if (stateChanged && running) playPowerWave(els.btnToggle.parentElement);

  if (animate && stateChanged) {
    flashPowerState();
  }

  els.btnToggleIcon.textContent = nextIcon;
  els.btnToggleText.textContent = nextLabel;
  els.btnToggleIcon.classList.toggle('is-stop', running);
  lastPowerRunning = running;
}

function flashStatusText(): void {
  els.statusText.classList.remove('status-flash');
  void els.statusText.offsetWidth;
  els.statusText.classList.add('status-flash');
  els.statusText.addEventListener('animationend', () => els.statusText.classList.remove('status-flash'), {
    once: true,
  });
}

function updateLayout(status: StatusPayload): void {
  const missing = !status.pathsValid;
  const changed = lastLayoutMissing !== null && lastLayoutMissing !== missing;
  lastLayoutMissing = missing;

  els.emptyState.classList.toggle('hidden', !missing);
  els.mainPanel.classList.toggle('hidden', missing);
  document.body.classList.toggle('zapret-missing', missing);

  if (changed) {
    if (missing) playPanelEnter(els.emptyState);
    else playPanelEnter(els.mainPanel);
  }
}

function setLogExpanded(expanded: boolean): void {
  focusJournal(expanded);
}

async function runTool(label: string, fn: () => Promise<{ ok: boolean }>, options?: { isTest?: boolean }): Promise<void> {
  if (busy) {
    hintBusy();
    return;
  }
  setBusy(true, label);
  if (options?.isTest) {
    resetTestUi();
    testQuietMode = true;
  }
  setJournalTitle(label);
  setJournalStatus('Выполняется...');
  clearJournal();
  focusJournal(true);
  if (!options?.isTest) log(label, 'info');
  try {
    await fn();
    setJournalStatus('Готово');
    if (label === 'Запуск обхода') toast('Обход запущен', 'success');
    else if (options?.isTest && lastTestBest) toast(`Лучший: ${lastTestBest.strategy.replace('.bat', '')}`, 'success');
    else if (label !== 'Остановка обхода') toast('Готово', 'success');
  } catch (err) {
    reportFailure(err);
    setJournalStatus('Ошибка');
  } finally {
    testQuietMode = false;
    setBusy(false);
    void refreshStatus();
  }
}

function handleToolOutput(line: { text: string; level: string }): void {
  if (line.text.startsWith(TEST_PROGRESS_PREFIX)) {
    try {
      const data = JSON.parse(line.text.slice(TEST_PROGRESS_PREFIX.length)) as {
        current: number;
        total: number;
        strategy: string;
      };
      showTestProgress(data.current, data.total, data.strategy);
    } catch {
      /* ignore */
    }
    return;
  }

  if (line.text.startsWith(TEST_STRATEGY_DONE_PREFIX)) {
    try {
      const data = JSON.parse(line.text.slice(TEST_STRATEGY_DONE_PREFIX.length)) as {
        strategy: string;
        pct: number;
        okChecks: number;
        totalChecks: number;
        failed?: string[];
        ms?: number;
      };
      if (data.ms) pickTimings.push(data.ms);
      addPickLiveRow(data);
      const level: JournalLevel = data.pct >= 50 ? 'success' : 'warn';
      appendJournalLine(
        `${data.strategy.replace('.bat', '')} — ${data.pct}% (${data.okChecks}/${data.totalChecks} OK)`,
        level
      );
    } catch {
      /* ignore */
    }
    return;
  }

  if (line.text.startsWith(TEST_RESULT_PREFIX)) {
    try {
      const payload = JSON.parse(line.text.slice(TEST_RESULT_PREFIX.length)) as TestResultPayload;
      renderTestResults(payload);
      if (strategyPickActive) {
        els.strategyPickProgressText.textContent = 'Завершение...';
        els.strategyPickProgressBar.style.width = '100%';
        els.strategyPickProgressPct.textContent = '100%';
      }
      if (payload.best) {
        const pct =
          payload.best.maxScore > 0 ? Math.round((payload.best.score / payload.best.maxScore) * 100) : 0;
        appendJournalLine(
          `★ Лучший: ${payload.best.strategy.replace('.bat', '')} — ${pct}%`,
          'success'
        );
      }
    } catch {
      /* ignore */
    }
    return;
  }

  if (testQuietMode) {
    if (line.level === 'error') appendJournalLine(line.text, 'error');
    return;
  }

  const level: JournalLevel =
    line.level === 'success' ? 'success' : line.level === 'error' ? 'error' : line.level === 'warn' ? 'warn' : 'info';
  const text = line.text.replace(/^\[(?:OK|X|\?)\]\s*/i, '').trim();
  if (!text || /^╨/.test(text)) return;
  appendJournalLine(text, level);
}
/** true — действие выполнено; false — занято другой операцией или упало с ошибкой */
async function runAction(label: string, fn: () => Promise<unknown>): Promise<boolean> {
  if (busy) {
    hintBusy();
    return false;
  }
  setBusy(true, label);
  log(label, 'info');
  try {
    await fn();
    log('Готово', 'success');
    await refreshStatus();
    return true;
  } catch (err) {
    reportFailure(err);
    return false;
  } finally {
    setBusy(false);
  }
}

function statusRenderKey(status: StatusPayload, configPath: string): string {
  return JSON.stringify({
    path: configPath,
    running: status.bypass.running,
    pid: status.bypass.pid,
    strategies: status.strategies,
    selected: status.selectedStrategy,
    gameFilter: status.settings.gameFilter,
    ipset: status.settings.ipset,
    checkUpdates: status.settings.checkUpdates,
    pathsValid: status.pathsValid,
    isOfficial: status.isOfficial,
    installedVersion: status.installedVersion,
  });
}

function renderStatus(status: StatusPayload, configPath: string): void {
  currentStatus = status;
  const renderKey = statusRenderKey(status, configPath);
  const skipHeavyUi = renderKey === lastStatusRenderKey;
  lastStatusRenderKey = renderKey;

  updateLayout(status);
  updateQuickBypass(status);
  if (skipHeavyUi) {
    updateControls(status);
    syncCustomSelectsDisabled(status);
    return;
  }

  els.zapretPath.textContent = configPath || '—';

  els.updZapretVersion.textContent = status.pathsValid
    ? `Zapret v${status.installedVersion ?? '?'}${status.isOfficial ? '' : ' · неофициальная сборка'}`
    : 'Zapret не найден';

  if (!status.pathsValid) {
    setTag(els.officialBadge, 'Не найден', 'bad');
    setTag(els.versionLine, '—', 'muted');
  } else if (status.isOfficial) {
    setTag(els.officialBadge, 'Официальный', 'ok');
    setTag(els.versionLine, `v${status.installedVersion ?? '?'}`, 'muted');
  } else {
    setTag(els.officialBadge, 'Неофициальный', 'bad');
    setTag(els.versionLine, `v${status.installedVersion ?? '?'}`, 'warn');
  }

  const running = status.bypass.running;
  // classList, а не className: иначе слетают status-pill (кликабельность) и is-loading
  els.statusBadge.classList.toggle('running', running);
  els.statusBadge.classList.toggle('warning', !running && !(status.pathsValid && status.isOfficial));
  els.statusBadge.title = !status.pathsValid
    ? 'Zapret не установлен — открыть страницу обхода'
    : !status.isOfficial
      ? 'Неофициальная сборка zapret — открыть страницу обхода'
      : running
        ? `Обход включён${status.selectedStrategy ? ` · ${status.selectedStrategy.replace(/\.bat$/i, '')}` : ''}`
        : 'Обход выключен — открыть страницу обхода';
  document.body.classList.toggle('app-running', running);

  updatePowerButton(running, true);

  // подпись одна, как у чипов Telegram и VPN; состояние видно по точке и подсказке
  const nextStatus = 'Обход';
  if (els.statusText.textContent !== nextStatus) {
    flashStatusText();
    els.statusText.textContent = nextStatus;
  }

  const strategiesKey = `${status.strategies.join('|')}|${status.selectedStrategy ?? ''}`;
  if (strategiesKey !== lastStrategiesKey) {
    lastStrategiesKey = strategiesKey;
    els.strategySelect.innerHTML = '';
    for (const strategy of status.strategies) {
      const opt = document.createElement('option');
      opt.value = strategy;
      opt.textContent = strategy.replace('.bat', '');
      if (strategy === status.selectedStrategy) opt.selected = true;
      els.strategySelect.appendChild(opt);
    }
    strategyCustomSelect?.rebuild();
  } else if (status.selectedStrategy && els.strategySelect.value !== status.selectedStrategy) {
    els.strategySelect.value = status.selectedStrategy;
    strategyCustomSelect?.rebuild();
  }

  const currentName = status.selectedStrategy?.replace('.bat', '') ?? 'не выбран';
  const count = status.strategies.length;
  els.configMeta.textContent =
    count > 0 ? `Сейчас: ${currentName} · ${formatConfigCount(count)} для проверки` : 'Конфиги .bat не найдены';

  const settingsKey = `${status.settings.gameFilter}|${status.settings.ipset}|${status.settings.checkUpdates}`;
  if (settingsKey !== lastSettingsKey) {
    lastSettingsKey = settingsKey;
    els.gameFilterSelect.value = status.settings.gameFilter;
    gameFilterCustomSelect?.rebuild();
    els.ipsetToggle.checked = status.settings.ipset === 'loaded';
    els.ipsetModeSelect.value = ['loaded', 'any', 'none'].includes(status.settings.ipset)
      ? status.settings.ipset
      : 'none';
    ipsetCustomSelect?.rebuild();
    els.checkUpdatesToggle.checked = status.settings.checkUpdates;
  }

  updateControls(status);
  syncCustomSelectsDisabled(status);
}

type BypassHealth = 'off' | 'checking' | 'ok' | 'degraded' | 'recovering' | 'down';

interface BypassActivity {
  health: BypassHealth;
  healthLabel: string;
  network: string;
  since: { at: number; strategy: string | null } | null;
  events: { at: number; kind: string; text: string; strategy?: string | null }[];
  retryAt?: number | null;
  canRecover?: boolean;
  game?: string | null;
  foreignVpn?: string | null;
}

const HEALTH_DOT_CLASS: Partial<Record<BypassHealth, string>> = {
  ok: 'is-ok',
  degraded: 'is-warn',
  recovering: 'is-warn',
  down: 'is-bad',
};

const EVENT_TONE: Record<string, string> = {
  game: 'is-info',
  crashed: 'is-warn',
  blocked: 'is-warn',
  'gave-up': 'is-bad',
  retry: 'is-warn',
  restored: 'is-ok',
  switched: 'is-ok',
};

let lastBypassRunning = false;

/** Время ближайшего события (повтор не дальше часа) — без даты, даже если оно уже завтра */
function formatTimeOnly(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
}

function formatEventTime(at: number): string {
  const date = new Date(at);
  const time = date.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  if (date.toDateString() === new Date().toDateString()) return time;
  return `${date.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' })} ${time}`;
}

async function refreshBypassActivity(running = lastBypassRunning): Promise<void> {
  lastBypassRunning = running;
  let activity: BypassActivity;
  try {
    activity = await api.getBypassActivity();
  } catch {
    return;
  }

  const parts: string[] = [];
  if (running) {
    const since = activity.since;
    const strategy = since?.strategy?.replace(/\.bat$/i, '');
    parts.push(since ? `Работает${strategy ? ` на ${strategy}` : ''} с ${formatEventTime(since.at)}` : 'Работает');
    parts.push(activity.healthLabel);
  } else if (activity.health === 'down') {
    parts.push(
      activity.retryAt
        ? `Рабочий конфиг не найден — попробую снова в ${formatTimeOnly(activity.retryAt)}`
        : 'Обход остановился: рабочий конфиг не найден'
    );
  }
  if (running && activity.foreignVpn) {
    parts.push(`весь трафик идёт через VPN «${activity.foreignVpn}» — отключите его, иначе YouTube будет отваливаться`);
  }
  if (activity.game) parts.push(`игровой режим: ${activity.game}`);
  parts.push(`сеть: ${activity.network}`);
  const canRepair =
    !!activity.canRecover && (activity.health === 'down' || (running && activity.health === 'degraded'));
  els.btnRecoverNow.classList.toggle('hidden', !canRepair);
  els.bypassActivityText.textContent = parts.join(' · ');
  els.bypassHealthDot.className = `health-dot ${running || activity.health === 'down' ? HEALTH_DOT_CLASS[activity.health] ?? '' : ''}`;

  els.bypassHistoryList.replaceChildren(
    ...activity.events.map((event) => {
      const item = document.createElement('li');
      const time = document.createElement('time');
      time.dateTime = new Date(event.at).toISOString();
      time.textContent = formatEventTime(event.at);
      const text = document.createElement('span');
      text.textContent = event.text;
      const tone = EVENT_TONE[event.kind];
      if (tone) text.className = tone;
      item.append(time, text);
      return item;
    })
  );
  els.bypassActivity.classList.toggle('hidden', !running && activity.events.length === 0 && activity.health !== 'down');
}

async function refreshStatus(full = true): Promise<void> {
  if (statusRefreshInFlight) {
    statusRefreshQueued = full || statusRefreshQueued;
    return;
  }
  statusRefreshInFlight = true;
  try {
    const { config, status } = await api.getDashboardState({ light: !full });
    renderStatus(status, config.zapretPath);
    els.launchAtStartupToggle.checked = !!config.launchAtStartup;
    els.autoStartBypassToggle.checked = !!config.autoStartBypass;
    els.autoPickStrategyToggle.checked = config.autoPickBestStrategy !== false;
    els.minimizeToTrayToggle.checked = config.minimizeToTray !== false;
    els.autoUpdateZapretToggle.checked = config.autoUpdateZapret !== false;
    els.bypassAutoRecoverToggle.checked = config.bypassAutoRecover !== false;
    els.bypassAutoSwitchToggle.checked = config.bypassAutoSwitch !== false;
    els.bypassAutoSwitchToggle.disabled ||= !els.bypassAutoRecoverToggle.checked;
    els.backgroundRerankToggle.checked = config.backgroundRerank !== false;
    if (document.activeElement !== els.probeSitesInput) {
      els.probeSitesInput.value = (config.probeSites ?? []).join(', ');
    }
    els.gameModeToggle.checked = config.gameMode !== false;
    els.gameProcessesInput.disabled ||= !els.gameModeToggle.checked;
    if (document.activeElement !== els.gameProcessesInput) {
      els.gameProcessesInput.value = (config.gameProcesses ?? []).join(', ');
    }
    showOfficialWarning(status);
    void refreshBypassActivity(status.bypass.running);
    if (full) {
      void loadUserLists();
    }
  } catch (err) {
    log(formatUserError(err), 'error');
  } finally {
    statusRefreshInFlight = false;
    if (statusRefreshQueued) {
      const nextFull = statusRefreshQueued;
      statusRefreshQueued = false;
      void refreshStatus(nextFull);
    }
  }
}

function scheduleStatusPoll(): void {
  if (statusPollTimer !== null) {
    window.clearInterval(statusPollTimer);
    statusPollTimer = null;
  }

  const hidden = !appWindowVisible || document.hidden;
  if (hidden) return;

  statusPollTimer = window.setInterval(() => {
    if (!busy) void refreshStatus(false);
  }, POLL_VISIBLE_MS);
}

function setAppWindowVisible(visible: boolean): void {
  appWindowVisible = visible;
  document.body.classList.toggle('app-hidden', !visible || document.hidden);
  scheduleStatusPoll();
  if (visible && !busy) {
    void refreshStatus();
    void loadTgwsState();
  }
}

function finishBootstrap(state: BootstrapState): void {
  if (state.stage === 'not-found') {
    log(state.message, 'info');
    bootstrapKickStarted = true;
    setDownloadingUi(false);
    void refreshStatus();
    return;
  }

  const logKey = `${state.stage}:${state.message}`;
  const shouldLog = logKey !== lastBootstrapLogKey;
  if (shouldLog) {
    lastBootstrapLogKey = logKey;
  }

  showBootstrapBanner('', false);
  els.bootstrapBanner.classList.remove('notice-loading');
  if (shouldLog) {
    log(state.message, state.stage === 'error' ? 'error' : state.autoFixed ? 'success' : 'info');
  }
  if (state.stage === 'error') {
    showBootstrapBanner(state.message, true);
    setDownloadingUi(false);
  }
  if (state.stage === 'ready' || state.stage === 'error' || state.autoFixed) {
    setGlobalLoad({ visible: false });
    setDownloadingUi(false);
    setHeroLoading(false);
    setStatusLoading(false);
    els.statusText.textContent = 'Обход';
  }
  void refreshStatus().then(() => {
    if (state.stage === 'ready' || state.autoFixed) {
      void maybeStartAutoPick();
    }
  });
  // Фоновое автообновление zapret тоже присылает bootstrap-complete — не снимаем busy,
  // который держит чужая операция (диагностика, подбор), иначе можно запустить две сразу
  if (busy && BOOTSTRAP_BUSY_LABELS.has(busyLabel)) setBusy(false);
}

const BOOTSTRAP_BUSY_LABELS = new Set(['Поиск zapret', 'Загрузка zapret']);

function handleBootstrapState(state: BootstrapState): void {
  const downloading =
    state.stage === 'downloading' || state.stage === 'updating' || state.stage === 'scanning';
  showBootstrapBanner(state.message, downloading && state.stage !== 'ready');
  els.bootstrapBanner.classList.toggle('notice-loading', downloading);
  if (downloading) {
    setBusy(true, 'Загрузка zapret');
    setDownloadingUi(true, state.message);
    const stage = state.stage === 'scanning' ? 'scan' : 'download';
    setGlobalLoad({
      visible: true,
      title: state.stage === 'scanning' ? 'Поиск zapret' : 'Загрузка zapret',
      message: state.message,
      percent: state.stage === 'scanning' ? 35 : 12,
      stage,
      indeterminate: state.stage === 'scanning',
    });
    setStatusLoading(true, state.stage === 'scanning' ? 'Поиск...' : 'Загрузка...');
  }
}

async function rescan(): Promise<void> {
  if (busy) {
    hintBusy();
    return;
  }
  setBusy(true, 'Поиск zapret');
  log('Сканирование компьютера...', 'info');
  try {
    const state = await api.rescanZapret();
    if (state) finishBootstrap(state);
    else await refreshStatus();
  } catch (err) {
    reportFailure(err);
  } finally {
    setBusy(false);
  }
}

async function downloadZapret(): Promise<void> {
  if (busy) {
    hintBusy();
    return;
  }
  setBusy(true, 'Загрузка zapret');
  setDownloadingUi(true);
  setGlobalLoad({
    visible: true,
    title: 'Установка zapret',
    message: 'Подготовка...',
    percent: 4,
    stage: 'fetch',
  });
  log('Установка zapret...', 'info');
  try {
    const result = await api.downloadZapret();
    log(`Установлен zapret ${result.version}`, 'success');
    await refreshStatus();
    void loadUserLists(true);
  } catch (err) {
    reportFailure(err, 'Не удалось установить zapret');
    showBootstrapBanner(formatUserError(err), true);
    setDownloadingUi(false);
    setGlobalLoad({
      visible: true,
      title: 'Ошибка загрузки',
      message: formatUserError(err),
      stage: 'error',
    });
    scheduleGlobalLoadHide(8000);
  } finally {
    setBusy(false);
  }
}

async function kickBootstrapIfMissing(): Promise<void> {
  if (bootstrapKickStarted || currentStatus?.pathsValid) return;
  if (!currentStatus) {
    // refreshStatus мог вернуться без данных, если уже шёл параллельный запрос
    try {
      const { status } = await api.getDashboardState({ light: true });
      if (status.pathsValid) return;
    } catch {
      /* продолжаем как при отсутствии zapret */
    }
  }
  try {
    const config = await api.getConfig();
    if (config.skipAutoBootstrap) return;
  } catch {
    /* continue if config unavailable */
  }
  bootstrapKickStarted = true;
  setBusy(true, 'Поиск zapret');
  setDownloadingUi(true, 'Поиск или загрузка zapret...');
  setGlobalLoad({
    visible: true,
    title: 'Поиск zapret',
    message: 'Поиск или загрузка zapret...',
    stage: 'scan',
    indeterminate: true,
  });
  try {
    const state = await api.rescanZapret();
    if (state && (state.stage === 'ready' || state.stage === 'error')) {
      finishBootstrap(state);
    }
  } catch (err) {
    reportFailure(err);
    setDownloadingUi(false);
  } finally {
    setBusy(false);
  }
}

async function pickPath(): Promise<void> {
  if (busy) {
    hintBusy();
    return;
  }
  setBusy(true, 'Выбор папки');
  log('Выбор папки zapret...', 'info');
  try {
    await api.setZapretPath();
    log('Путь обновлён', 'success');
    await refreshStatus();
  } catch (err) {
    reportFailure(err);
  } finally {
    setBusy(false);
  }
}

async function init(): Promise<void> {
  initUi();
  initLoading({
    progressWrap: els.progressWrap,
    progressFill: els.progressFill,
    progressText: els.progressText,
    progressTitle: els.progressTitle,
    progressPct: els.progressPct,
    progressStages: els.progressStages,
    statusBadge: els.statusBadge,
    statusText: els.statusText,
    heroLoader: els.heroLoader,
    heroLogoWrap: els.heroLogoWrap,
    btnToggle: els.btnToggle,
    powerSpinner: els.powerSpinner,
    testProgressWrap: els.testProgressWrap,
    testProgressBar: els.testProgressBar,
    testProgressText: els.testProgressText,
    testProgressPct: els.testProgressPct,
    strategyPickProgressWrap: document.getElementById('strategyPickProgressWrap')!,
    strategyPickProgressBar: els.strategyPickProgressBar,
    strategyPickProgressText: els.strategyPickProgressText,
    strategyPickProgressPct: els.strategyPickProgressPct,
    strategyPickSpinner: els.strategyPickSpinner,
  });
  strategyCustomSelect = enhanceSelect(els.strategySelect);
  gameFilterCustomSelect = enhanceSelect(els.gameFilterSelect);
  ipsetCustomSelect = enhanceSelect(els.ipsetModeSelect);
  userListCustomSelect = enhanceSelect(els.userListKind);
  applyUserListEditor(currentUserListKind());

  if (!window.zapretApi) {
    els.statusText.textContent = 'Ошибка preload';
    log('Не удалось подключить backend. Перезапустите приложение.', 'error');
    return;
  }

  window.zapretApi.onBootstrapStatus(handleBootstrapState);
  window.zapretApi.onBootstrapComplete(finishBootstrap);
  window.zapretApi.onDownloadProgress(showDownloadProgress);
  window.zapretApi.onToolOutput(handleToolOutput);
  window.zapretApi.onBypassAutoStarted(() => {
    lastStatusRenderKey = '';
    void refreshStatus();
  });
  window.zapretApi.onStrategyAutoPicked(() => {
    lastStatusRenderKey = '';
    void refreshStatus();
  });
  window.zapretApi.onAppWindowVisibility(({ visible }) => setAppWindowVisible(visible));
  document.addEventListener('visibilitychange', () => {
    document.body.classList.toggle('app-hidden', !appWindowVisible || document.hidden);
    scheduleStatusPoll();
  });
  window.zapretApi.onAutoStartBlocked((payload) => {
    if (payload.reason !== 'admin' || autoStartBlockedNotified) return;
    autoStartBlockedNotified = true;
    els.adminBanner.classList.remove('hidden');
    showInfoModal(
      'Нужны права администратора',
      'Автозапуск обхода работает только при запуске от администратора.',
      'Запустите приложение от имени администратора или нажмите «Перезапуск от администратора» вверху окна.'
    );
    log('Автозапуск обхода пропущен: нужны права администратора', 'info');
  });
  window.zapretApi.onAppUpdateAvailable((info) => showAppUpdateBanner(info));
  void refreshAppVersionLine();

  log('Skvoz запущен', 'info');
  setStatusLoading(true, 'Подключение...');
  await refreshAdminState();
  updateControls(null);

  try {
    const state = await api.getBootstrapState();
    if (state) {
      handleBootstrapState(state);
      if (state.stage === 'ready' || state.stage === 'error') {
        finishBootstrap(state);
      }
    }
  } catch {
    /* bootstrap ещё не готов */
  }

  await refreshStatus();
  setStatusLoading(false);
  void loadLastTestResults();

  if (!currentStatus?.pathsValid) {
    void kickBootstrapIfMissing();
  }

  window.setTimeout(() => {
    if (els.statusBadge.classList.contains('is-loading')) {
      void refreshStatus();
    }
  }, 2000);
}

void init();
scheduleStatusPoll();

let appUpdateCheckRunning = false;
els.linkCheckAppUpdate.addEventListener('click', (e) => {
  e.preventDefault();
  if (appUpdateCheckRunning) return;
  appUpdateCheckRunning = true;
  const label = els.linkCheckAppUpdate.textContent;
  els.linkCheckAppUpdate.textContent = 'Проверяем…';
  void api
    .checkAppUpdate()
    .then((info) => {
      if (info.checkFailed) {
        toast('Не удалось связаться с GitHub — попробуйте позже', 'error');
      } else if (info.upToDate || !info.latest) {
        toast(`У вас последняя версия Skvoz ${info.current}`, 'success');
      } else {
        showAppUpdateBanner(info);
        toast(`Доступна версия ${info.latest}`, 'info');
        window.scrollTo({ top: 0 });
      }
    })
    .catch((err) => toast(formatUserError(err), 'error'))
    .finally(() => {
      appUpdateCheckRunning = false;
      els.linkCheckAppUpdate.textContent = label;
    });
});

els.btnAppChangelog.addEventListener('click', () => void api.openAppReleasePage());
els.linkAppRepo.addEventListener('click', (e) => {
  e.preventDefault();
  void api.openAppReleasePage();
});

els.btnInstallAppUpdate.addEventListener('click', () => void installAppUpdate());

els.btnOpenAppRelease.addEventListener('click', () => void api.openAppReleasePage());

els.btnDismissAppUpdate.addEventListener('click', () => {
  if (!pendingAppUpdateInfo?.latest) {
    els.appUpdateBanner.classList.add('hidden');
    return;
  }
  void (async () => {
    await api.dismissAppUpdate(pendingAppUpdateInfo!.latest!);
    showAppUpdateBanner(null);
    toast('Напомним при следующем запуске', 'info');
  })();
});

els.linkAppDocs.addEventListener('click', () => void api.openExternal('https://github.com/tw1xtyq/skvoz#readme'));
document.getElementById('linkAppSite')?.addEventListener('click', () => void api.openExternal('https://tw1xtyq.github.io'));

document.getElementById('creditLinks')?.addEventListener('click', (event) => {
  const link = (event.target as HTMLElement).closest<HTMLElement>('[data-url]');
  if (link?.dataset.url) void api.openExternal(link.dataset.url);
});

els.linkOfficial.addEventListener('click', (e) => {
  e.preventDefault();
  void api.openDownloadPage();
});

els.btnToggle.addEventListener('click', () => {
  if (!currentStatus || busy) return;
  const running = currentStatus.bypass.running;
  void runAction(running ? 'Остановка обхода' : 'Запуск обхода', () =>
    running ? api.stopBypass() : api.startBypass()
  ).then(() => {
    // После включения сразу показываем, открываются ли сайты
    if (!running && currentStatus?.bypass.running) {
      window.setTimeout(() => void runAccessCheck(), 2_500);
    }
  });
});

els.btnFullRemove.addEventListener('click', () => {
  void (async () => {
    const folder = els.zapretPath.textContent?.trim();
    const message = [
      'Будет выполнено:',
      '• Остановка winws.exe',
      '• Удаление всех найденных папок zapret',
      '• Сброс настроек приложения',
      folder && folder !== '—' ? `\nПапка: ${folder}` : '',
      '\nSkvoz останется на компьютере.',
    ]
      .filter(Boolean)
      .join('\n');

    const ok = await confirmModal('Удалить zapret с ПК', message);
    if (!ok) return;

    await runTool('Полное удаление zapret', async () => {
      const result = await api.fullRemoveZapret();
      bootstrapKickStarted = true;
      return result;
    });
  })();
});

els.btnRescan.addEventListener('click', () => void rescan());
els.btnRescanEmpty.addEventListener('click', () => void rescan());
els.btnDownload.addEventListener('click', () => void downloadZapret());
els.btnDownloadInline.addEventListener('click', () => void downloadZapret());
els.btnChangePath.addEventListener('click', () => void pickPath());
els.btnChangePathEmpty.addEventListener('click', () => void pickPath());
// Пока идёт другая операция, выбор не применится — возвращаем прежнее значение, а не врём в списке
els.strategySelect.addEventListener('change', async () => {
  if (!(await runAction('Стратегия', () => api.setStrategy(els.strategySelect.value)))) {
    els.strategySelect.value = currentStatus?.selectedStrategy ?? '';
    strategyCustomSelect?.rebuild();
  }
});
els.gameFilterSelect.addEventListener('change', async () => {
  const applied = await runAction('Фильтр', async () => {
    const result = await api.setGameFilter(els.gameFilterSelect.value);
    if (result.restarted) toast('Игровой фильтр применён — обход перезапущен', 'success');
  });
  if (!applied) {
    els.gameFilterSelect.value = currentStatus?.settings.gameFilter ?? els.gameFilterSelect.value;
    gameFilterCustomSelect?.rebuild();
  }
});
els.userListKind.addEventListener('change', () => applyUserListEditor(currentUserListKind()));
els.btnUserListSave.addEventListener('click', () => void saveUserListFromEditor());
els.btnUserListAdd.addEventListener('click', () => void addUserListQuick());
els.userListQuickAdd.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    void addUserListQuick();
  }
});
els.ipsetModeSelect.addEventListener('change', () => {
  const mode = els.ipsetModeSelect.value as 'loaded' | 'any' | 'none';
  void (async () => {
    if (busy) {
      els.ipsetModeSelect.value = currentStatus?.settings.ipset ?? 'none';
      ipsetCustomSelect?.rebuild();
      hintBusy();
      return;
    }
    setBusy(true, 'Смена IPSet');
    try {
      const result = await api.setIpsetMode(mode);
      els.ipsetToggle.checked = result.ipset === 'loaded';
      els.ipsetModeSelect.value = result.ipset;
      ipsetCustomSelect?.rebuild();
      const ipsetToasts = { loaded: 'IPSet включён', any: 'IPSet: любой IP', none: 'IPSet выключен' };
      toast(`${ipsetToasts[result.ipset]}${result.restarted ? ' — обход перезапущен' : ''}`, 'success');
      await refreshStatus();
    } catch (err) {
      els.ipsetModeSelect.value = currentStatus?.settings.ipset ?? 'none';
      ipsetCustomSelect?.rebuild();
      reportFailure(err);
    } finally {
      setBusy(false);
    }
  })();
});
/**
 * Настройки приложения не трогают zapret — не захватываем общий busy (из-за него клики
 * по другим кнопкам терялись) и не делаем полное обновление статуса. При ошибке
 * возвращаем переключатель, чтобы он не показывал несохранённое значение.
 */
function bindSettingToggle(
  input: HTMLInputElement,
  label: string,
  apply: (checked: boolean) => Promise<unknown>
): void {
  input.addEventListener('change', async () => {
    const checked = input.checked;
    input.disabled = true;
    try {
      await apply(checked);
    } catch (err) {
      input.checked = !checked;
      reportFailure(err, label);
    } finally {
      input.disabled = false;
      updateControls(currentStatus);
    }
  });
}

els.checkUpdatesToggle.addEventListener('change', async () => {
  if (!(await runAction('Обновления', () => api.setCheckUpdates(els.checkUpdatesToggle.checked)))) {
    els.checkUpdatesToggle.checked = !els.checkUpdatesToggle.checked;
  }
});
bindSettingToggle(els.launchAtStartupToggle, 'Автозапуск', (checked) => api.setLaunchAtStartup(checked));
bindSettingToggle(els.autoStartBypassToggle, 'Автозапуск обхода', async (checked) => {
  const result = await api.setAutoStartBypass(checked);
  if (result.launchAtStartup) els.launchAtStartupToggle.checked = true;
});
bindSettingToggle(els.autoPickStrategyToggle, 'Автоподбор конфига', async (checked) => {
  await api.setAutoPickBestStrategy(checked);
  if (checked) void maybeStartAutoPick();
});
bindSettingToggle(els.autoUpdateZapretToggle, 'Автообновление zapret', (checked) => api.setAutoUpdateZapret(checked));
bindSettingToggle(els.bypassAutoRecoverToggle, 'Автовосстановление обхода', (checked) =>
  api.setBypassAutoRecover(checked)
);
bindSettingToggle(els.bypassAutoSwitchToggle, 'Переключение конфига при сбое', (checked) =>
  api.setBypassAutoSwitch(checked)
);
bindSettingToggle(els.backgroundRerankToggle, 'Перепроверка в простое', (checked) =>
  api.setBackgroundRerank(checked)
);
els.gameModeToggle.addEventListener('change', () => {
  els.gameProcessesInput.disabled = !els.gameModeToggle.checked;
});
bindSettingToggle(els.gameModeToggle, 'Игровой режим', (checked) => api.setGameMode(checked));
els.gameProcessesInput.addEventListener('change', async () => {
  const names = els.gameProcessesInput.value.split(/[,;\n]+/).map((n) => n.trim()).filter(Boolean);
  try {
    const result = await api.setGameProcesses(names);
    els.gameProcessesInput.value = result.gameProcesses.join(', ');
    if (result.rejected.length > 0) toast(`Не похоже на exe: ${result.rejected.join(', ')}`, 'info');
    else toast(result.gameProcesses.length > 0 ? 'Список игр сохранён' : 'Только встроенный список игр', 'success');
  } catch (err) {
    reportFailure(err);
  }
});
els.probeSitesInput.addEventListener('change', async () => {
  const sites = els.probeSitesInput.value.split(/[,\s]+/).filter(Boolean);
  try {
    const result = await api.setProbeSites(sites);
    els.probeSitesInput.value = result.probeSites.join(', ');
    if (result.rejected.length > 0) toast(`Не похоже на адрес: ${result.rejected.join(', ')}`, 'info');
    else toast(result.probeSites.length > 0 ? 'Сайты для проверки сохранены' : 'Проверка по YouTube и Discord', 'success');
  } catch (err) {
    reportFailure(err);
  }
});
els.btnRecoverNow.addEventListener('click', async () => {
  els.btnRecoverNow.disabled = true;
  try {
    await api.recoverBypassNow();
    toast('Восстанавливаю обход…', 'info');
  } catch (err) {
    reportFailure(err, 'Восстановление');
  } finally {
    els.btnRecoverNow.disabled = false;
    void refreshBypassActivity();
  }
});
els.btnSaveReport.addEventListener('click', async () => {
  try {
    const result = await api.saveDiagnosticReport();
    if (result.saved) toast('Отчёт сохранён', 'success');
  } catch (err) {
    reportFailure(err);
  }
});
api.onBypassActivityChanged(() => void refreshBypassActivity());
bindSettingToggle(els.minimizeToTrayToggle, 'Сворачивание в трей', (checked) => api.setMinimizeToTray(checked));
els.btnDiagnostics.addEventListener('click', () => void runTool('Диагностика', () => api.runDiagnostics()));
els.btnFindBest.addEventListener('click', () => void runPickBestStrategy({ quick: true }));
els.btnFullCheck.addEventListener('click', () => void runPickBestStrategy({ quick: false }));
els.btnCancelStrategyPick.addEventListener('click', () => {
  if (!strategyPickActive) return;
  els.btnCancelStrategyPick.disabled = true;
  els.strategyPickProgressText.textContent = 'Отмена...';
  void api.cancelPickBestStrategy();
});
els.btnTests.addEventListener('click', () => void runCurrentStrategyTest());
els.testResults.addEventListener('click', (event) => {
  const target = event.target as HTMLElement;
  const row = target.closest<HTMLElement>('[data-strategy]');
  if (!row?.dataset.strategy || busy) return;
  void applyStrategy(row.dataset.strategy);
});
els.btnProcessStatus.addEventListener('click', () => void runTool('Статус обхода', () => api.getProcessStatus()));
els.btnCheckUpdates.addEventListener('click', () => {
  void (async () => {
    if (busy) {
    hintBusy();
    return;
  }
    setBusy(true, 'Проверка версии');
    try {
      const [zapretUpdate, appUpdate] = await Promise.all([api.checkUpdates(), api.checkAppUpdate()]);
      const noGithub = 'не удалось проверить — нет связи с GitHub.';
      const zapretMessage = zapretUpdate.checkFailed
        ? `Zapret: ${noGithub}`
        : zapretUpdate.upToDate
          ? `Zapret: последняя версия${zapretUpdate.current ? ` (${zapretUpdate.current})` : ''}.`
          : `Zapret: доступна ${zapretUpdate.latest ?? '?'}, сейчас ${zapretUpdate.current ?? '?'}.`;
      const appMessage = appUpdate.checkFailed
        ? `Skvoz: ${noGithub}`
        : appUpdate.upToDate
          ? `Skvoz: последняя версия (v${appUpdate.current}).`
          : `Skvoz: доступна v${appUpdate.latest ?? '?'}, сейчас v${appUpdate.current}.`;
      const message = `${appMessage}\n${zapretMessage}`;

      if (!appUpdate.upToDate && appUpdate.latest) {
        showAppUpdateBanner(appUpdate);
      }

      showInfoModal('Проверка обновлений', message);
      const allCurrent = appUpdate.upToDate && zapretUpdate.upToDate && !zapretUpdate.checkFailed;
      log(message.replace(/\n/g, ' '), allCurrent ? 'success' : 'info');
    } catch (err) {
      reportFailure(err);
    } finally {
      setBusy(false);
    }
  })();
});
restoreJournalCollapsed();
document.getElementById('btnToggleJournal')?.addEventListener('click', () => {
  setJournalCollapsed(!isJournalCollapsed());
});
els.btnClearLog.addEventListener('click', () => {
  clearJournal();
  setJournalTitle('Журнал');
  setJournalStatus('');
});
els.btnCopyLog.addEventListener('click', () => {
  void (async () => {
    const ok = await copyJournal();
    toast(ok ? 'Журнал скопирован' : 'Нечего копировать', ok ? 'success' : 'info');
  })();
});
els.btnRestartAdmin?.addEventListener('click', () => {
  void (async () => {
    try {
      await api.restartAsAdmin();
      toast('Подтвердите UAC — приложение перезапустится', 'info');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      toast(message, 'error');
    }
  })();
});

// ── App tabs ────────────────────────────────────────────────────────────────

type AppView = 'home' | 'bypass' | 'telegram' | 'vpn' | 'settings' | 'tools' | 'about';

const APP_VIEW_TITLES: Record<AppView, [string, string]> = {
  home: ['Главная', 'Что включено и что открывается прямо сейчас'],
  bypass: ['Обход', 'YouTube и Discord без VPN с помощью zapret'],
  telegram: ['Telegram', 'Прокси на этом компьютере, только для Telegram'],
  vpn: ['VPN', 'Весь интернет через VPN-сервер'],
  settings: ['Настройки', 'Запуск, автоматика обхода, фильтры и обновления'],
  tools: ['Помощь', 'Если что-то не работает: диагностика, журнал и удаление'],
  about: ['О Skvoz', 'Версия, ссылки, авторы и лицензии'],
};

function moveNavIndicator(): void {
  const active = document.querySelector<HTMLElement>('.side-nav-btn.is-active');
  const indicator = document.querySelector<HTMLElement>('.side-nav-indicator');
  if (!active || !indicator) return;
  indicator.style.transform = `translateY(${active.offsetTop + active.offsetHeight / 2 - 12}px)`;
}

window.addEventListener('resize', moveNavIndicator);
initMotion();

function setActiveAppView(view: AppView): void {
  try {
    localStorage.setItem('zapret-app-view', view);
  } catch {
    /* ignore */
  }
  const order = Object.keys(APP_VIEW_TITLES);
  const previous = order.indexOf(document.body.dataset.appView ?? view);
  // Новый раздел приходит с той стороны, куда идём по меню
  document.documentElement.style.setProperty('--page-shift', order.indexOf(view) < previous ? '-14px' : '14px');
  document.body.dataset.appView = view;
  document.querySelectorAll<HTMLElement>('.page').forEach((page) => {
    page.classList.toggle('is-active', page.dataset.page === view);
  });
  document.querySelectorAll<HTMLButtonElement>('.side-nav-btn').forEach((button) => {
    button.classList.toggle('is-active', button.dataset.view === view);
  });
  const [title, subtitle] = APP_VIEW_TITLES[view];
  const head = els.pageTitle.parentElement;
  if (els.pageTitle.textContent !== title && head) {
    head.classList.remove('swap');
    void head.offsetWidth; // перезапуск анимации заголовка
    head.classList.add('swap');
  }
  els.pageTitle.textContent = title;
  els.pageSubtitle.textContent = subtitle;
  moveNavIndicator();
  if (view === 'settings') restoreSettingsTab();
  window.scrollTo({ top: 0, behavior: 'instant' });
}

document.querySelectorAll<HTMLButtonElement>('.side-nav-btn, [data-goto]').forEach((button) => {
  button.addEventListener('click', () => {
    setActiveAppView(((button.dataset.view ?? button.dataset.goto) as AppView) ?? 'home');
    // ссылка может вести сразу на нужную вкладку настроек
    if (button.dataset.settingsTab) selectSettingsTab(button.dataset.settingsTab);
  });
});
// ── Вкладки настроек: на экране только выбранный раздел ─────────────────────

const SETTINGS_TAB_KEY = 'zapret-app-settings-tab';

function settingsTabButtons(): HTMLButtonElement[] {
  return Array.from(document.querySelectorAll<HTMLButtonElement>('.settings-tabs [data-tab]'));
}

/** Фильтры и списки без zapret скрыты — тогда открываем первую доступную вкладку */
function isSettingsTabAvailable(button: HTMLButtonElement): boolean {
  return !(button.classList.contains('needs-zapret') && document.body.classList.contains('zapret-missing'));
}

function selectSettingsTab(tab?: string | null, focus = false): void {
  const buttons = settingsTabButtons();
  const target =
    buttons.find((button) => button.dataset.tab === tab && isSettingsTabAvailable(button)) ??
    buttons.find(isSettingsTabAvailable);
  if (!target) return;
  for (const button of buttons) {
    const active = button === target;
    button.classList.toggle('is-current', active);
    button.setAttribute('aria-selected', String(active));
    button.tabIndex = active ? 0 : -1;
    document.getElementById(button.dataset.tab ?? '')?.classList.toggle('is-tab-active', active);
  }
  moveTabPill();
  if (focus) target.focus();
  try {
    localStorage.setItem(SETTINGS_TAB_KEY, target.dataset.tab ?? '');
  } catch {
    /* ignore */
  }
}

function restoreSettingsTab(): void {
  let saved: string | null = null;
  try {
    saved = localStorage.getItem(SETTINGS_TAB_KEY);
  } catch {
    /* ignore */
  }
  selectSettingsTab(saved);
}

for (const button of settingsTabButtons()) {
  button.addEventListener('click', () => {
    selectSettingsTab(button.dataset.tab);
    window.scrollTo({ top: 0, behavior: 'instant' });
  });
  // стрелки переключают вкладки, как в обычном tablist
  button.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
    event.preventDefault();
    const available = settingsTabButtons().filter(isSettingsTabAvailable);
    const index = available.indexOf(button);
    const next = available[(index + (event.key === 'ArrowRight' ? 1 : -1) + available.length) % available.length];
    selectSettingsTab(next?.dataset.tab, true);
  });
}
restoreSettingsTab();

els.btnQuickBypass.addEventListener('click', () => {
  if (currentStatus?.pathsValid) els.btnToggle.click();
  else void downloadZapret();
});
document.querySelectorAll<HTMLButtonElement>('[data-install-zapret]').forEach((button) => {
  button.addEventListener('click', () => void downloadZapret());
});
els.btnBypassDeckToggle.addEventListener('click', () => els.btnToggle.click());
els.btnVpnDeckToggle.addEventListener('click', () => els.btnQuickVpn.click());
els.btnQuickTg.addEventListener('click', () => els.btnTgToggle.click());
els.btnQuickVpn.addEventListener('click', () => {
  // Без конфига — сразу создаём WARP с автоподбором: один клик от Главной до работающего VPN
  if (vpnState?.configured || vpnState?.running) void toggleVpn();
  else void createWarpVpn('auto', 'auto');
});

// Restore last selected tab
{
  let saved: string | null = null;
  try {
    saved = localStorage.getItem('zapret-app-view');
  } catch {
    /* ignore */
  }
  if (saved === 'auto') saved = 'settings';
  setActiveAppView(saved && Object.prototype.hasOwnProperty.call(APP_VIEW_TITLES, saved) ? (saved as AppView) : 'home');
}

// меню трея открывает окно сразу на нужной странице
api?.onNavigate((view) => {
  if (Object.prototype.hasOwnProperty.call(APP_VIEW_TITLES, view)) setActiveAppView(view as AppView);
});

function flashButton(button: HTMLButtonElement, text: string): void {
  const original = button.dataset.label ?? button.textContent ?? '';
  button.dataset.label = original;
  button.textContent = text;
  button.classList.add('is-flashed');
  window.setTimeout(() => {
    button.textContent = original;
    button.classList.remove('is-flashed');
  }, 1_400);
}

// F5 / Ctrl+R — обновить статус вместо перезагрузки окна
document.addEventListener('keydown', (event) => {
  const reload = event.key === 'F5' || (event.ctrlKey && event.key.toLowerCase() === 'r');
  if (!reload) return;
  event.preventDefault();
  if (busy) return;
  void refreshStatus(true);
  void loadTgwsState();
  void loadVpnState();
  toast('Статус обновлён', 'info');
});

// Ctrl+1…7 — страницы
const HOTKEY_VIEWS: AppView[] = ['home', 'bypass', 'telegram', 'vpn', 'settings', 'tools', 'about'];
document.addEventListener('keydown', (event) => {
  if (!event.ctrlKey || event.altKey || event.shiftKey || event.metaKey) return;
  const index = Number(event.key) - 1;
  const view = HOTKEY_VIEWS[index];
  if (!view || strategyPickActive) return;
  if (!document.getElementById('modalOverlay')?.classList.contains('hidden')) return;
  event.preventDefault();
  setActiveAppView(view);
});

// ── Проверка доступа ────────────────────────────────────────────────────────

let accessCheckRunning = false;

async function runAccessCheck(): Promise<void> {
  if (accessCheckRunning) return;
  accessCheckRunning = true;
  els.btnCheckAccess.disabled = true;
  els.btnCheckAccess.textContent = 'Проверяем…';
  els.accessMeta.textContent = 'Открываем сайты и стучимся в Telegram…';
  els.accessGrid.querySelectorAll<HTMLElement>('.access-item').forEach((item) => {
    item.className = 'access-item is-checking';
    item.querySelector('.access-detail')!.textContent = 'проверяем…';
    item.querySelector('.access-ms')!.textContent = '';
  });
  try {
    const results = await api.checkAccess();
    for (const result of results) {
      const item = els.accessGrid.querySelector<HTMLElement>(`[data-service="${result.id}"]`);
      if (!item) continue;
      item.className = `access-item is-${result.status}`;
      item.querySelector('.access-detail')!.textContent = result.detail;
      item.querySelector('.access-ms')!.textContent = result.ms !== null ? `${result.ms} мс` : '';
      item.title = `${result.name}: ${result.detail}`;
    }
    const okCount = results.filter((r) => r.status === 'ok').length;
    const time = new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
    els.accessMeta.textContent = `Проверено в ${time} · работает ${okCount} из ${results.length}`;
  } catch (err) {
    els.accessMeta.textContent = 'Не удалось проверить доступ';
    log(formatUserError(err), 'error');
  } finally {
    accessCheckRunning = false;
    els.btnCheckAccess.disabled = false;
    els.btnCheckAccess.textContent = 'Проверить';
  }
}

els.btnCheckAccess.addEventListener('click', () => void runAccessCheck());

// При открытии сразу показываем, что работает, — пустые «не проверялось» ничего не говорят
window.setTimeout(() => {
  if (currentStatus?.pathsValid && !accessCheckRunning) void runAccessCheck();
}, 3_000);

// ── Telegram proxy tab ──────────────────────────────────────────────────────

/** Прокси добавляют в Telegram один раз, потом его достаточно включать */
function tgLinkAdded(): boolean {
  try {
    return localStorage.getItem('skvoz-tg-link-added') === '1';
  } catch {
    return false;
  }
}

function setTgLinkAdded(added: boolean): void {
  try {
    if (added) localStorage.setItem('skvoz-tg-link-added', '1');
    else localStorage.removeItem('skvoz-tg-link-added');
  } catch {
    /* ignore */
  }
}

async function openTgLink(): Promise<void> {
  const link = els.tgProxyLink.value.trim();
  if (!link) {
    toast('Ссылка прокси пуста', 'info');
    return;
  }
  try {
    await api.openExternal(link);
    setTgLinkAdded(true);
    void loadTgwsState();
  } catch (err) {
    reportFailure(err, 'Не удалось открыть Telegram');
  }
}

async function loadTgwsState(): Promise<void> {
  try {
    const state = await api.tgwsStatus();
    tgwsConfig = state.config;
    tgwsRunning = state.running;
    tgwsStats = state.stats;

    // Deck title / meta / dot
    const linkAdded = tgLinkAdded();
    const startLabel = linkAdded ? 'Включить' : 'Подключить Telegram';
    els.tgDeckTitle.textContent = tgwsRunning ? 'Telegram-прокси включён' : 'Telegram-прокси выключен';
    els.tgDeckMeta.textContent = tgwsRunning
      ? 'Telegram не подключается? Нажмите «Открыть в Telegram» и добавьте прокси'
      : linkAdded
        ? 'Прокси уже добавлен в Telegram, осталось его включить'
        : 'Нажмите кнопку: прокси включится, а Telegram предложит его добавить';
    els.tgStatusDot.classList.toggle('is-live', tgwsRunning);
    els.statusTg.classList.toggle('running', tgwsRunning);
    els.statusTg.title = tgwsRunning ? 'Telegram-прокси работает' : 'Telegram-прокси выключен';

    // Stats
    els.tgStatTotal.textContent = String(tgwsStats.total);
    els.tgStatActive.textContent = String(tgwsStats.active);
    els.tgStatWs.textContent = String(tgwsStats.ws);
    els.tgStatTcp.textContent = String(tgwsStats.tcp);
    els.tgStatBad.textContent = String(tgwsStats.bad);

    // Buttons
    els.btnTgToggle.textContent = tgwsRunning ? 'Выключить' : startLabel;
    els.btnTgOpenTg.classList.toggle('hidden', !tgwsRunning);
    els.btnTgToggle.classList.toggle('btn-glow', !tgwsRunning);
    els.btnTgToggle.classList.toggle('btn-soft', tgwsRunning);
    els.quickTgCard.classList.toggle('is-live', tgwsRunning);
    els.quickTgDot.classList.toggle('is-live', tgwsRunning);
    els.quickTgText.textContent = tgwsRunning ? 'Включён' : 'Выключен';
    els.quickTgMeta.textContent = tgwsRunning
      ? `Подключений сейчас: ${tgwsStats.active}`
      : tgwsConfig.autostart
        ? 'Запускается вместе с приложением'
        : '';
    els.btnQuickTg.textContent = tgwsRunning ? 'Выключить' : startLabel;
    els.btnQuickTg.disabled = busy;
    els.btnTgToggle.disabled = busy;

    // Proxy link
    const link = await api.tgwsProxyLink();
    els.tgProxyLink.value = link ?? '';

    // Config fields — не затираем то, что пользователь сейчас редактирует
    if (!tgConfigDirty) {
      els.tgPort.value = String(tgwsConfig.port);
      els.tgHost.value = tgwsConfig.host;
      els.tgSecret.value = tgwsConfig.secretHex;
    }
    els.tgAutostart.checked = tgwsConfig.autostart;
  } catch (err) {
    log(`TG proxy: ${formatUserError(err)}`, 'error');
  }
}

function startTgwsPoll(): void {
  if (tgwsPollTimer) clearInterval(tgwsPollTimer);
  tgwsPollTimer = window.setInterval(() => {
    if (!appWindowVisible || document.hidden) return;
    void loadTgwsState();
    void loadVpnState();
  }, 5_000);
}

function stopTgwsPoll(): void {
  if (tgwsPollTimer) {
    clearInterval(tgwsPollTimer);
    tgwsPollTimer = null;
  }
}

els.btnTgToggle.addEventListener('click', async () => {
  if (busy) {
    hintBusy();
    return;
  }
  setBusy(true, 'Telegram proxy');
  try {
    if (tgwsRunning) {
      await api.tgwsStop();
      toast('Прокси выключен', 'info');
    } else {
      await api.tgwsStart();
      toast('Прокси включён', 'success');
    }
    await loadTgwsState();
    if (tgwsRunning && !tgLinkAdded()) await openTgLink();
  } catch (err) {
    reportFailure(err, 'Ошибка управления прокси');
  } finally {
    setBusy(false);
  }
});

els.btnTgDisconnect.addEventListener('click', async () => {
  if (busy) {
    hintBusy();
    return;
  }
  if (!tgwsRunning) return;
  setBusy(true, 'Telegram proxy');
  try {
    await api.tgwsStop();
    toast('Прокси остановлен', 'info');
    await loadTgwsState();
  } catch (err) {
    reportFailure(err, 'Ошибка остановки прокси');
  } finally {
    setBusy(false);
  }
});

els.btnTgCopyLink.addEventListener('click', async () => {
  const link = els.tgProxyLink.value.trim();
  if (!link) {
    toast('Ссылка прокси пуста', 'info');
    return;
  }
  try {
    await navigator.clipboard.writeText(link);
    toast('Ссылка скопирована', 'success');
    flashButton(els.btnTgCopyLink, 'Скопировано ✓');
  } catch {
    toast('Не удалось скопировать', 'error');
  }
});

els.btnTgOpenTg.addEventListener('click', () => void openTgLink());

els.tgAutostart.addEventListener('change', () => {
  const enabled = els.tgAutostart.checked;
  void api
    .tgwsSetConfig({ autostart: enabled })
    .then(() => {
      toast(enabled ? 'Прокси будет запускаться вместе с приложением' : 'Автозапуск прокси выключен', 'success');
      void loadTgwsState();
    })
    .catch((err) => {
      els.tgAutostart.checked = !enabled;
      reportFailure(err, 'Не удалось сохранить автозапуск прокси');
    });
});

for (const input of [els.tgPort, els.tgHost, els.tgSecret]) {
  input.addEventListener('input', () => { tgConfigDirty = true; });
  input.addEventListener('change', () => { tgConfigDirty = true; });
}

els.btnTgGenSecret.addEventListener('click', () => {
  tgConfigDirty = true;
  const hex = Array.from(crypto.getRandomValues(new Uint8Array(16)))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  els.tgSecret.value = hex;
});

els.btnTgSaveConfig.addEventListener('click', async () => {
  if (busy) {
    hintBusy();
    return;
  }
  const portVal = Number(els.tgPort.value);
  if (!Number.isInteger(portVal) || portVal < 1 || portVal > 65535) {
    toast('Неверный порт (1–65535)', 'error');
    return;
  }
  const secretVal = els.tgSecret.value.trim();
  if (secretVal && !/^[0-9a-fA-F]{32}$/.test(secretVal)) {
    toast('Секрет должен быть 32 hex-символа', 'error');
    return;
  }
  setBusy(true, 'Сохранение прокси');
  try {
    const updates: Partial<TgwsProxyConfig> = {
      port: portVal,
      host: els.tgHost.value.trim() || '127.0.0.1',
    };
    if (secretVal) updates.secretHex = secretVal;
    const linkChanged =
      updates.port !== tgwsConfig?.port ||
      updates.host !== tgwsConfig?.host ||
      (!!secretVal && secretVal !== tgwsConfig?.secretHex);
    await api.tgwsSetConfig(updates);
    if (linkChanged) setTgLinkAdded(false);
    tgConfigDirty = false;
    toast('Конфигурация сохранена', 'success');
    await loadTgwsState();
  } catch (err) {
    reportFailure(err, 'Ошибка сохранения конфигурации');
  } finally {
    setBusy(false);
  }
});

// Initialize TG state on load
void loadTgwsState();
startTgwsPoll();

// ── VPN (AmneziaWG) ─────────────────────────────────────────────────────────

function formatTraffic(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} КБ`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} МБ`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} ГБ`;
}

function formatHandshake(seconds: number | null): string {
  if (seconds === null) return '—';
  if (seconds < 60) return `${seconds} с`;
  return `${Math.floor(seconds / 60)} мин`;
}

function renderVpnState(state: VpnState): void {
  const { running, configured, summary } = state;
  const pending = vpnBusy || state.busy || state.serviceState.endsWith('_PENDING');
  // Рукопожатие старше 3 минут — сервер не отвечает, хотя служба работает
  const stale = running && (state.handshakeAgoSec === null || state.handshakeAgoSec > 180);

  els.vpnDeckTitle.textContent = vpnProgressText
    ? 'Настраиваем VPN…'
    : pending
    ? 'Подключаемся…'
    : running
      ? `Подключено к ${summary?.endpoint ?? 'серверу'}`
      : configured
        ? 'VPN выключен'
        : 'Конфиг не добавлен';
  els.vpnDeckMeta.textContent = vpnProgressText
    ? vpnProgressText
    : running
    ? stale
      ? 'Ждём ответа сервера — если долго нет, проверьте конфиг'
      : summary?.fullTunnel
        ? 'Весь трафик идёт через VPN'
        : 'Через VPN идут адреса из AllowedIPs'
    : configured
      ? 'Нажмите «Включить» — трафик пойдёт через VPN'
      : state.bundled
        ? 'Нажмите «Создать и подключить» — конфиг появится сам'
        : 'В этой сборке нет файлов AmneziaWG — переустановите Skvoz';
  els.vpnStatusDot.classList.toggle('is-live', running && !stale && !vpnProgressText);
  els.statusVpn.classList.toggle('running', running && !stale);
  els.statusVpn.classList.toggle('warning', running && stale);
  els.statusVpn.title = running ? (stale ? 'VPN: ждём ответа сервера' : 'VPN подключён') : 'VPN выключен';
  els.vpnStatusDot.classList.toggle('is-pending', !!vpnProgressText || pending);
  els.vpnStatHandshake.textContent = running ? formatHandshake(state.handshakeAgoSec) : '—';
  els.vpnStatRx.textContent = formatTraffic(state.rxBytes);
  els.vpnStatTx.textContent = formatTraffic(state.txBytes);

  els.vpnEndpoint.textContent = summary?.endpoint ?? '—';
  els.vpnAddress.textContent = summary?.address ?? '—';
  els.vpnObfuscation.textContent = summary ? (summary.obfuscated ? 'AmneziaWG (включена)' : 'нет, обычный WireGuard') : '—';
  els.btnVpnRemoveConfig.disabled = vpnBusy || !configured;
  els.btnVpnImportFile.disabled = vpnBusy;
  els.btnVpnSaveText.disabled = vpnBusy;
  els.btnVpnExport.disabled = vpnBusy || !configured;
  els.btnVpnGenerate.disabled = vpnBusy;
  vpnEndpointSelect?.setDisabled(vpnBusy);
  vpnPresetSelect?.setDisabled(vpnBusy);
  els.vpnAutostart.checked = state.autostart;

  els.quickVpnCard.classList.toggle('is-live', running);
  els.quickVpnCard.classList.toggle('is-unavailable', !configured && !running);
  els.quickVpnDot.classList.toggle('is-live', running && !stale);
  els.quickVpnText.textContent = vpnProgressText
    ? vpnProgressText
    : pending
    ? 'Подключаемся…'
    : running
      ? stale
        ? 'Ждём ответа сервера'
        : 'Включён'
      : configured
        ? 'Выключен'
        : 'Ещё не настроен';
  els.quickVpnMeta.textContent = running
    ? `${summary?.endpoint ?? ''} · ↓ ${formatTraffic(state.rxBytes)} ↑ ${formatTraffic(state.txBytes)}`
    : configured && state.autostart
      ? 'Подключается вместе с приложением'
      : '';
  els.btnQuickVpn.textContent = running ? 'Выключить' : configured ? 'Включить' : 'Создать VPN';
  els.btnQuickVpn.disabled = strategyPickActive || vpnBusy;
  els.btnVpnDeckToggle.textContent = running ? 'Выключить' : 'Включить';
  // без конфига единственная кнопка создания — в карточке ниже
  els.btnVpnDeckToggle.classList.toggle('hidden', !configured && !running);
  if (!vpnProgressText) els.btnVpnGenerate.textContent = configured ? 'Создать новый конфиг' : 'Создать и подключить';
  els.btnVpnDeckToggle.disabled = els.btnQuickVpn.disabled;
  els.btnVpnDeckToggle.classList.toggle('btn-glow', !running);
  els.btnVpnDeckToggle.classList.toggle('btn-soft', running);
}

async function loadVpnState(): Promise<void> {
  try {
    vpnState = await api.vpnStatus();
    renderVpnState(vpnState);
  } catch (err) {
    log(`VPN: ${formatUserError(err)}`, 'error');
  }
}

async function runVpnAction(action: () => Promise<void>, failureTitle: string): Promise<void> {
  if (vpnBusy) return;
  vpnBusy = true;
  if (vpnState) renderVpnState(vpnState);
  try {
    await action();
  } catch (err) {
    reportFailure(err, failureTitle);
  } finally {
    vpnBusy = false;
    await loadVpnState();
  }
}

async function toggleVpn(): Promise<void> {
  const wasRunning = !!vpnState?.running;
  await runVpnAction(async () => {
    if (wasRunning) {
      await api.vpnDisconnect();
      toast('VPN выключен', 'info');
    } else {
      await api.vpnConnect();
      toast('VPN подключён', 'success');
    }
  }, wasRunning ? 'Не удалось выключить VPN' : 'Не удалось подключить VPN');
}

els.btnVpnImportFile.addEventListener('click', () => {
  void runVpnAction(async () => {
    const result = await api.vpnImportFile();
    if (result.canceled) return;
    toast(`Конфиг добавлен · ${result.summary.endpoint}`, 'success');
  }, 'Не удалось добавить конфиг');
});

els.btnVpnSaveText.addEventListener('click', () => {
  const text = els.vpnConfigText.value.trim();
  if (!text) {
    toast('Вставьте текст конфига', 'info');
    return;
  }
  void runVpnAction(async () => {
    const { summary } = await api.vpnImportText(text);
    // Приватный ключ не держим на экране дольше нужного
    els.vpnConfigText.value = '';
    toast(`Конфиг сохранён · ${summary.endpoint}`, 'success');
  }, 'Не удалось сохранить конфиг');
});

els.btnVpnRemoveConfig.addEventListener('click', () => {
  void (async () => {
    const ok = await confirmModal('Удалить конфиг VPN', 'VPN отключится, а конфиг с ключом будет удалён с компьютера.');
    if (!ok) return;
    await runVpnAction(async () => {
      await api.vpnRemoveConfig();
      toast('Конфиг удалён', 'info');
    }, 'Не удалось удалить конфиг');
  })();
});

els.btnVpnGenerate.addEventListener('click', () => {
  void (async () => {
    if (vpnState?.configured) {
      const ok = await confirmModal(
        'Создать новый конфиг',
        'Текущий конфиг VPN будет заменён новым конфигом Cloudflare WARP.',
        'Если старый пригодится, сначала сохраните его кнопкой «Сохранить в файл».'
      );
      if (!ok) return;
    }
    await createWarpVpn(els.vpnGenEndpoint.value, els.vpnGenPreset.value);
  })();
});

async function createWarpVpn(endpoint: string, preset: string): Promise<void> {
  vpnProgressText = 'Готовим генератор…';
  els.btnVpnGenerate.textContent = 'Настраиваем…';
  await runVpnAction(async () => {
    try {
      const result = await api.vpnGenerateWarp({ endpoint, preset });
      toast(`VPN подключён · ${result.candidate.endpoint}`, 'success');
    } catch (error) {
      // Показываем запасной путь — генерацию в облаке
      els.vpnCloudHelp.open = true;
      setActiveAppView('vpn');
      throw error;
    } finally {
      vpnProgressText = null;
      els.btnVpnGenerate.textContent = 'Создать и подключить';
    }
  }, 'Не удалось создать VPN');
}

api.onVpnProgress(({ text }) => {
  if (!vpnBusy) return;
  vpnProgressText = text;
  if (vpnState) renderVpnState(vpnState);
});

els.btnVpnCloudOpen.addEventListener('click', () => {
  void api.openExternal(els.btnVpnCloudOpen.dataset.url!);
});
els.btnVpnCloudImport.addEventListener('click', () => els.btnVpnImportFile.click());

els.btnVpnExport.addEventListener('click', () => {
  void runVpnAction(async () => {
    const result = await api.vpnExportConfig();
    if (!result.canceled) toast('Конфиг сохранён в файл — никому не показывайте его', 'success');
  }, 'Не удалось сохранить конфиг');
});

void api
  .vpnWarpEndpoints()
  .then((endpoints) => {
    for (const endpoint of endpoints) els.vpnGenEndpoint.add(new Option(endpoint.label, endpoint.value));
    els.vpnGenEndpoint.value = 'auto';
    els.vpnGenPreset.value = 'auto';
    vpnEndpointSelect = enhanceSelect(els.vpnGenEndpoint);
    vpnPresetSelect = enhanceSelect(els.vpnGenPreset);
  })
  .catch((err) => log(`VPN: ${formatUserError(err)}`, 'error'));

els.vpnAutostart.addEventListener('change', () => {
  const enabled = els.vpnAutostart.checked;
  void api
    .vpnSetAutostart(enabled)
    .then(() => {
      toast(enabled ? 'VPN будет подключаться вместе с приложением' : 'Автозапуск VPN выключен', 'success');
      void loadVpnState();
    })
    .catch((err) => {
      els.vpnAutostart.checked = !enabled;
      reportFailure(err, 'Не удалось сохранить автозапуск VPN');
    });
});

void loadVpnState();

els.btnUpdateIpset.addEventListener('click', () => {
  void runTool('Обновление IPSet', () => api.updateIpsetList());
});
els.btnUpdateHosts.addEventListener('click', () => {
  void runTool('Обновление hosts', () => api.updateHostsFile());
});
els.btnRemoveServices.addEventListener('click', () => {
  void runTool('Удаление служб zapret', () => api.removeZapretServices());
});

export {};
