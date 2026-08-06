import {
  appendJournalLine,
  clearJournal,
  copyJournal,
  focusJournal,
  setJournalStatus,
  setJournalTitle,
  type JournalLevel,
} from './journal.js';
import { confirmModal, formatUserError, initUi, showErrorModal, showInfoModal, toast } from './ui.js';
import { applyTheme, getAppliedTheme, type AppTheme } from './theme.js';
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
}

interface AppUpdateInfo {
  current: string;
  latest: string | null;
  upToDate: boolean;
  releasePage: string | null;
  releaseNotes: string | null;
}

interface ZapretApi {
  getConfig(): Promise<{
    zapretPath: string;
    selectedStrategy: string | null;
    theme?: AppTheme;
    launchAtStartup?: boolean;
    autoStartBypass?: boolean;
    autoPickBestStrategy?: boolean;
    skipAutoBootstrap?: boolean;
  }>;
  getDashboardState(options?: { light?: boolean }): Promise<{
    config: {
      zapretPath: string;
      selectedStrategy: string | null;
      theme?: AppTheme;
      launchAtStartup?: boolean;
      autoStartBypass?: boolean;
      autoPickBestStrategy?: boolean;
      skipAutoBootstrap?: boolean;
    };
    status: StatusPayload;
  }>;
  setTheme(theme: AppTheme): Promise<{ theme: AppTheme }>;
  setLaunchAtStartup(enabled: boolean): Promise<{ launchAtStartup: boolean }>;
  setAutoStartBypass(enabled: boolean): Promise<{ autoStartBypass: boolean; launchAtStartup?: boolean }>;
  setAutoPickBestStrategy(enabled: boolean): Promise<{ autoPickBestStrategy: boolean }>;
  getBootstrapState(): Promise<BootstrapState | null>;
  rescanZapret(): Promise<BootstrapState | null>;
  getStatus(): Promise<StatusPayload>;
  setZapretPath(): Promise<{ zapretPath: string; selectedStrategy: string | null }>;
  setStrategy(strategy: string): Promise<{ zapretPath: string; selectedStrategy: string | null }>;
  startBypass(): Promise<{ ok: boolean }>;
  stopBypass(): Promise<{ ok: boolean }>;
  fullRemoveZapret(): Promise<{ ok: boolean; removedPaths: string[] }>;
  setGameFilter(mode: string): Promise<{ ok: boolean }>;
  toggleIpset(): Promise<{ ok: boolean; ipset: string }>;
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
  runPickBestStrategy(): Promise<{
    cancelled: boolean;
    strategy: string | null;
    score: number;
    okChecks: number;
    totalChecks: number;
  }>;
  cancelPickBestStrategy(): Promise<{ ok: boolean }>;
  completePostBootstrap(): Promise<{ ok: boolean }>;
  getProcessStatus(): Promise<{ ok: boolean }>;
  checkUpdates(): Promise<{ current: string | null; latest: string | null; upToDate: boolean }>;
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
}

interface TestResultPayload {
  rankings: StrategyRanking[];
  best: StrategyRanking | null;
  targetCount: number;
}

type UserListKind = 'general' | 'exclude-domains' | 'exclude-ips';

const USER_LIST_HINTS: Record<UserListKind, string> = {
  general: 'Домены и IP для обхода — по одному на строку. Список не должен быть пустым.',
  'exclude-domains': 'Домены, которые zapret не трогает. Исключения важнее списка обхода.',
  'exclude-ips': 'IP или подсеть CIDR — не попадут под IPSet-фильтр.',
};

const api = window.zapretApi;

const ACTION_BUTTON_IDS = [
  'btnToggle',
  'btnDiagnostics',
  'btnFindBest',
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
  btnRescan: document.getElementById('btnRescan') as HTMLButtonElement,
  btnRescanEmpty: document.getElementById('btnRescanEmpty') as HTMLButtonElement,
  btnChangePath: document.getElementById('btnChangePath') as HTMLButtonElement,
  btnChangePathEmpty: document.getElementById('btnChangePathEmpty') as HTMLButtonElement,
  btnDownload: document.getElementById('btnDownload') as HTMLButtonElement,
  btnDownloadInline: document.getElementById('btnDownloadInline') as HTMLButtonElement,
  linkAppRepo: document.getElementById('linkAppRepo') as HTMLAnchorElement,
  linkOfficial: document.getElementById('linkOfficial') as HTMLAnchorElement,
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
  checkUpdatesToggle: document.getElementById('checkUpdatesToggle') as HTMLInputElement,
  launchAtStartupToggle: document.getElementById('launchAtStartupToggle') as HTMLInputElement,
  autoStartBypassToggle: document.getElementById('autoStartBypassToggle') as HTMLInputElement,
  autoPickStrategyToggle: document.getElementById('autoPickStrategyToggle') as HTMLInputElement,
  userListKind: document.getElementById('userListKind') as HTMLSelectElement,
  userListHint: document.getElementById('userListHint')!,
  userListEditor: document.getElementById('userListEditor') as HTMLTextAreaElement,
  userListQuickAdd: document.getElementById('userListQuickAdd') as HTMLInputElement,
  btnUserListAdd: document.getElementById('btnUserListAdd') as HTMLButtonElement,
  btnUserListSave: document.getElementById('btnUserListSave') as HTMLButtonElement,
  btnDiagnostics: document.getElementById('btnDiagnostics') as HTMLButtonElement,
  btnFindBest: document.getElementById('btnFindBest') as HTMLButtonElement,
  btnTests: document.getElementById('btnTests') as HTMLButtonElement,
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
  functionalPanel: document.getElementById('functionalPanel')!,
  pathActionsGroup: document.getElementById('pathActionsGroup')!,
  pathLockHint: document.getElementById('pathLockHint')!,
  runtimeSettingsGroup: document.getElementById('runtimeSettingsGroup')!,
  settingsLockHint: document.getElementById('settingsLockHint')!,
  configStrategyGroup: document.getElementById('configStrategyGroup')!,
  configTestsGroup: document.getElementById('configTestsGroup')!,
  configLockHint: document.getElementById('configLockHint')!,
  fullRemoveGroup: document.getElementById('fullRemoveGroup')!,
  themeToggle: document.getElementById('themeToggle') as HTMLButtonElement,
  strategyPickOverlay: document.getElementById('strategyPickOverlay')!,
  strategyPickTitle: document.getElementById('strategyPickTitle')!,
  strategyPickHint: document.getElementById('strategyPickHint')!,
  strategyPickProgressText: document.getElementById('strategyPickProgressText')!,
  strategyPickProgressPct: document.getElementById('strategyPickProgressPct')!,
  strategyPickProgressBar: document.getElementById('strategyPickProgressBar') as HTMLElement,
  strategyPickSpinner: document.getElementById('strategyPickSpinner')!,
  btnCancelStrategyPick: document.getElementById('btnCancelStrategyPick') as HTMLButtonElement,
};

let currentStatus: StatusPayload | null = null;
let busy = false;
let strategyPickActive = false;
let isAdminUser = false;
let lastTestBest: StrategyRanking | null = null;
let testQuietMode = false;
let bootstrapKickStarted = false;
let lastBootstrapLogKey = '';
let autoStartBlockedNotified = false;
let strategyCustomSelect: CustomSelectHandle | null = null;
let gameFilterCustomSelect: CustomSelectHandle | null = null;
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
let appUpdateDownloadReady = false;

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

function showTestProgress(current: number, total: number, strategy: string): void {
  const pct = total > 0 ? Math.round((current / total) * 100) : 0;
  const label = `${current} из ${total} · ${strategy.replace('.bat', '')}`;

  if (strategyPickActive) {
    setPickProgress({ visible: true, percent: pct, label });
  } else {
    setInlineTestProgress({ visible: true, percent: pct, label });
  }

  setJournalStatus(`Проверка ${current} из ${total}`);
}

function openStrategyPickOverlay(auto: boolean): void {
  els.strategyPickTitle.textContent = auto ? 'Автоподбор конфига' : 'Подбор лучшего конфига';
  els.strategyPickHint.textContent = auto
    ? 'Проверяем все стратегии при первом запуске. Можно отменить — останется конфиг по умолчанию.'
    : 'Проверяем все .bat. Другие действия недоступны до завершения или отмены.';
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

async function runPickBestStrategy(options: { auto?: boolean } = {}): Promise<void> {
  if (strategyPickActive || busy) return;

  setBusy(true);
  setStrategyPickActive(true);
  openStrategyPickOverlay(!!options.auto);
  resetTestUi();
  testQuietMode = true;
  clearJournal();
  setJournalTitle(options.auto ? 'Автоподбор конфига' : 'Подбор лучшего конфига');
  setJournalStatus('Запуск...');
  focusJournal(true);

  try {
    const result = await api.runPickBestStrategy();
    if (result.cancelled) {
      toast('Подбор конфига отменён', 'info');
      log('Подбор конфига отменён', 'info');
      setJournalStatus('Отменено');
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
    lastStatusRenderKey = '';
    await refreshStatus();
  } catch (err) {
    reportFailure(err);
    setJournalStatus('Ошибка');
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
  const tone = pct >= 70 ? 'good' : pct >= 40 ? 'mid' : 'low';
  return `<span class="test-pct"><span class="test-pct-track"><span class="test-pct-fill test-pct-${tone}" style="width:${pct}%"></span></span><span class="test-pct-val">${pct}%</span></span>`;
}

function renderTestResults(payload: TestResultPayload): void {
  if (!payload.best) return;
  lastTestBest = payload.best;
  els.testResults.classList.remove('hidden');

  const bestPct = payload.best.maxScore > 0 ? Math.round((payload.best.score / payload.best.maxScore) * 100) : 0;
  const bestName = payload.best.strategy.replace('.bat', '');

  let html = `<div class="test-best">
    <div class="test-best-copy">
      <span class="test-best-label">Лучший конфиг</span>
      <strong>${escapeHtml(bestName)}</strong>
      <span class="test-best-score">${bestPct}% · ${payload.best.okChecks}/${payload.best.totalChecks} OK</span>
    </div>
    <button class="btn btn-glow test-apply-btn" type="button" data-strategy="${escapeHtml(payload.best.strategy)}">Применить</button>
  </div>`;

  html += '<p class="test-table-hint">Нажмите на строку, чтобы выбрать другой конфиг</p>';
  html += '<div class="test-table-wrap"><div class="test-table">';
  html += '<div class="test-row test-head"><span>#</span><span>Конфиг</span><span>Результат</span></div>';

  payload.rankings.forEach((row, index) => {
    const pct = row.maxScore > 0 ? Math.round((row.score / row.maxScore) * 100) : 0;
    const isBest = row.strategy === payload.best?.strategy;
    html += `<button class="test-row test-row-btn${isBest ? ' test-row-best' : ''}" type="button" data-strategy="${escapeHtml(row.strategy)}">
      <span>${index + 1}</span>
      <span>${escapeHtml(row.strategy.replace('.bat', ''))}</span>
      ${renderTestPctBar(pct)}
    </button>`;
  });

  html += '</div></div>';
  els.testResults.innerHTML = html;
}

async function applyStrategy(name: string): Promise<void> {
  if (busy) return;
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
    els.runtimeSettingsGroup,
    els.configStrategyGroup,
    els.configTestsGroup,
    els.fullRemoveGroup,
  ];
  for (const group of groups) {
    group.classList.toggle('runtime-locked', locked);
  }
  els.pathLockHint.classList.toggle('hidden', !locked);
  els.settingsLockHint.classList.toggle('hidden', !locked);
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

  const configButtons = new Set(['btnFindBest', 'btnTests']);

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
      el.disabled = pickLocked || busy || !hasPath || runningLocked;
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
  els.gameFilterSelect.disabled = pickLocked || busy || !hasPath || runningLocked;
  els.ipsetToggle.disabled = pickLocked || busy || !hasPath || runningLocked;
  els.userListKind.disabled = pickLocked || busy || !hasPath || runningLocked;
  els.userListEditor.disabled = pickLocked || busy || !hasPath || runningLocked;
  els.userListQuickAdd.disabled = pickLocked || busy || !hasPath || runningLocked;
  els.btnUserListAdd.disabled = pickLocked || busy || !hasPath || runningLocked;
  els.btnUserListSave.disabled = pickLocked || busy || !hasPath || runningLocked;
  els.checkUpdatesToggle.disabled = pickLocked || busy || !hasPath || runningLocked;
  els.launchAtStartupToggle.disabled = pickLocked || busy;
  els.autoStartBypassToggle.disabled = pickLocked || busy;
  els.autoPickStrategyToggle.disabled = pickLocked || busy;
  els.themeToggle.disabled = pickLocked || busy;
  els.btnRestartAdmin.disabled = pickLocked || busy;
  els.btnCancelStrategyPick.disabled = !pickLocked;
  updateAdminHint(status);
}

function setBusy(value: boolean): void {
  busy = value;
  setActionBusy(value);
  updateControls(currentStatus);
  syncCustomSelectsDisabled(currentStatus);
}

function syncCustomSelectsDisabled(status: StatusPayload | null): void {
  const hasPath = !!status?.pathsValid;
  const runningLocked = !!status?.bypass.running && hasPath;
  const disabled = strategyPickActive || busy || !hasPath || runningLocked;
  strategyCustomSelect?.setDisabled(disabled);
  gameFilterCustomSelect?.setDisabled(disabled);
  userListCustomSelect?.setDisabled(disabled);
}

function currentUserListKind(): UserListKind {
  const value = els.userListKind.value;
  if (value === 'exclude-domains' || value === 'exclude-ips') return value;
  return 'general';
}

function applyUserListEditor(kind: UserListKind): void {
  els.userListHint.textContent = USER_LIST_HINTS[kind];
  els.userListEditor.value = userListsCache?.[kind] ?? '';
  els.userListQuickAdd.placeholder =
    kind === 'exclude-ips' ? '192.168.0.0/24' : 'example.com или 1.2.3.4';
}

async function loadUserLists(force = false): Promise<void> {
  if (!currentStatus?.pathsValid) {
    userListsCache = null;
    els.userListEditor.value = '';
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
  if (busy || !currentStatus?.pathsValid) return;
  const kind = currentUserListKind();
  setBusy(true);
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
  if (busy || !currentStatus?.pathsValid) return;
  const entry = els.userListQuickAdd.value.trim();
  if (!entry) return;

  const kind = currentUserListKind();
  setBusy(true);
  try {
    const result = await api.addUserListEntries(kind, [entry]);
    userListsCache = result.lists;
    applyUserListEditor(kind);
    els.userListQuickAdd.value = '';

    if (result.added.length > 0) {
      toast(`Добавлено: ${result.added[0]}`, 'success');
      userListApplyHint(!!currentStatus.bypass.running);
    } else if (result.skipped.length > 0) {
      toast('Уже есть в списке', 'info');
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
    els.appVersionLine.textContent = `Zapret App v${version}`;
  } catch {
    els.appVersionLine.textContent = 'Zapret App';
  }
}

async function installAppUpdate(): Promise<void> {
  if (busy || !pendingAppUpdateInfo?.latest) return;

  const latest = pendingAppUpdateInfo.latest;
  setBusy(true);
  appUpdateDownloadReady = false;
  setGlobalLoad({
    visible: true,
    title: 'Обновление Zapret App',
    message: `Скачиваем версию ${latest}...`,
    indeterminate: true,
    stage: 'download',
  });

  try {
    log(`Загрузка Zapret App ${latest}...`, 'info');
    await api.downloadAppUpdate();
    appUpdateDownloadReady = true;
    setGlobalLoad({
      visible: true,
      title: 'Обновление готово',
      message: 'Подтвердите установку в диалоге',
      percent: 100,
      stage: 'done',
    });

    const ok = await confirmModal(
      'Установить обновление',
      `Zapret App ${latest} скачан.\n\nПриложение перезапустится и установит обновление. Продолжить?`
    );
    if (!ok) {
      toast('Обновление скачано. Нажмите «Обновить» ещё раз для установки.', 'info');
      return;
    }

    await api.applyAppUpdate();
  } catch (err) {
    setGlobalLoad({
      visible: true,
      title: 'Ошибка обновления',
      message: formatUserError(err),
      stage: 'error',
    });
    reportFailure(err, 'Не удалось обновить');
  } finally {
    setBusy(false);
    if (!appUpdateDownloadReady) {
      setGlobalLoad({ visible: false });
    } else {
      window.setTimeout(() => setGlobalLoad({ visible: false }), 1200);
    }
  }
}

function showOfficialWarning(status: StatusPayload, bootstrap?: BootstrapState | null): void {
  const warnings = [...(bootstrap?.warnings ?? []), ...status.officialWarnings];
  const unofficial = !status.isOfficial || warnings.some((w) => w.toLowerCase().includes('неофици'));

  if (!unofficial && bootstrap?.autoFixed !== true) {
    els.officialWarning.classList.add('hidden');
    return;
  }

  els.officialWarning.innerHTML = `<strong>Предупреждение</strong>${
    bootstrap?.autoFixed ? 'Неофициальная сборка заменена. ' : ''
  }Официальный zapret: github.com/Flowseal/zapret-discord-youtube`;
  els.officialWarning.classList.remove('hidden');
}

function setDownloadingUi(active: boolean, message?: string): void {
  els.emptyStateTitle.textContent = active ? 'Загрузка zapret...' : 'Zapret не найден';
  els.emptyStateHint.textContent =
    message ??
    (active
      ? 'Скачиваем официальную сборку с GitHub. Это может занять минуту.'
      : 'Скачайте zapret или укажите папку — дальше всё из одного окна.');
  els.emptyStateActions.classList.toggle('hidden', active);
  setHeroLoading(active);
  els.btnDownload.disabled = active || busy;
  els.btnRescanEmpty.disabled = active || busy;
  els.btnChangePathEmpty.disabled = active || busy;
}

function showDownloadProgress(progress: DownloadProgress): void {
  const stage = mapDownloadStage(progress.stage);
  if (!currentStatus?.pathsValid) {
    setDownloadingUi(true, progress.message);
  }

  if (progress.stage === 'done') {
    setGlobalLoad({
      visible: true,
      title: 'Zapret установлен',
      message: progress.message,
      percent: 100,
      stage: 'done',
    });
    window.setTimeout(() => setGlobalLoad({ visible: false }), 1400);
    setHeroLoading(false);
    setDownloadingUi(false);
    els.statusText.textContent = 'Готово';
    return;
  }

  if (progress.stage === 'error') {
    setGlobalLoad({
      visible: true,
      title: 'Ошибка загрузки',
      message: progress.message,
      stage: 'error',
    });
    setHeroLoading(false);
    setDownloadingUi(false, progress.message);
    els.statusText.textContent = 'Ошибка';
    return;
  }

  setGlobalLoad({
    visible: true,
    title: stage === 'scan' ? 'Поиск zapret' : 'Загрузка zapret',
    message: progress.message,
    percent: progress.percent,
    stage,
    indeterminate: stage === 'scan' && progress.percent < 1,
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
  els.functionalPanel.classList.toggle('hidden', missing);

  if (changed) {
    if (missing) playPanelEnter(els.emptyState);
    else playPanelEnter(els.mainPanel, els.functionalPanel);
  }
}

function setLogExpanded(expanded: boolean): void {
  focusJournal(expanded);
}

async function runTool(label: string, fn: () => Promise<{ ok: boolean }>, options?: { isTest?: boolean }): Promise<void> {
  if (busy) return;
  setBusy(true);
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
      };
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
async function runAction(label: string, fn: () => Promise<unknown>): Promise<void> {
  if (busy) return;
  setBusy(true);
  log(label, 'info');
  try {
    await fn();
    log('Готово', 'success');
    await refreshStatus();
  } catch (err) {
    reportFailure(err);
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
  if (skipHeavyUi) {
    updateControls(status);
    syncCustomSelectsDisabled(status);
    return;
  }

  els.zapretPath.textContent = configPath || '—';

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
  els.statusBadge.className = `status-chip ${
    running ? 'running' : status.pathsValid && status.isOfficial ? '' : 'warning'
  }`;
  document.body.classList.toggle('app-running', running);

  updatePowerButton(running, true);

  const nextStatus = !status.pathsValid
    ? 'Нет zapret'
    : !status.isOfficial
      ? 'Неофициальный'
      : running
        ? 'Работает'
        : 'Готов';
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
    els.checkUpdatesToggle.checked = status.settings.checkUpdates;
  }

  updateControls(status);
  syncCustomSelectsDisabled(status);
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
    showOfficialWarning(status);
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
  if (visible && !busy) void refreshStatus();
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
  }
  void refreshStatus().then(() => {
    if (state.stage === 'ready' || state.autoFixed) {
      void maybeStartAutoPick();
    }
  });
  setBusy(false);
}

function handleBootstrapState(state: BootstrapState): void {
  const downloading =
    state.stage === 'downloading' || state.stage === 'updating' || state.stage === 'scanning';
  showBootstrapBanner(state.message, downloading && state.stage !== 'ready');
  els.bootstrapBanner.classList.toggle('notice-loading', downloading);
  if (downloading) {
    setBusy(true);
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
  if (busy) return;
  setBusy(true);
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
  if (busy) return;
  setBusy(true);
  setDownloadingUi(true);
  setGlobalLoad({
    visible: true,
    title: 'Загрузка zapret',
    message: 'Подключение к GitHub...',
    percent: 4,
    stage: 'fetch',
  });
  log('Загрузка официального zapret...', 'info');
  try {
    const result = await api.downloadZapret();
    log(`Установлен zapret ${result.version}`, 'success');
    await refreshStatus();
    void loadUserLists(true);
  } catch (err) {
    reportFailure(err, 'Не удалось скачать zapret');
    showBootstrapBanner(formatUserError(err), true);
    setDownloadingUi(false);
    setGlobalLoad({
      visible: true,
      title: 'Ошибка загрузки',
      message: formatUserError(err),
      stage: 'error',
    });
  } finally {
    setBusy(false);
  }
}

async function kickBootstrapIfMissing(): Promise<void> {
  if (bootstrapKickStarted || currentStatus?.pathsValid) return;
  try {
    const config = await api.getConfig();
    if (config.skipAutoBootstrap) return;
  } catch {
    /* continue if config unavailable */
  }
  bootstrapKickStarted = true;
  setBusy(true);
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
  if (busy) return;
  setBusy(true);
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

async function toggleTheme(): Promise<void> {
  const next: AppTheme = getAppliedTheme() === 'dark' ? 'light' : 'dark';
  applyTheme(next);
  try {
    await api.setTheme(next);
  } catch {
    /* local theme still applied */
  }
}

async function initTheme(): Promise<void> {
  try {
    const config = await api.getConfig();
    if (config.theme === 'light' || config.theme === 'dark') {
      applyTheme(config.theme);
    }
  } catch {
    applyTheme(getAppliedTheme());
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
  await initTheme();
  strategyCustomSelect = enhanceSelect(els.strategySelect);
  gameFilterCustomSelect = enhanceSelect(els.gameFilterSelect);
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

  log('Zapret App запущен', 'info');
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

els.linkAppRepo.addEventListener('click', (e) => {
  e.preventDefault();
  void api.openAppReleasePage();
});

els.btnInstallAppUpdate.addEventListener('click', () => {
  if (appUpdateDownloadReady) {
    void (async () => {
      const ok = await confirmModal(
        'Установить обновление',
        `Установить Zapret App ${pendingAppUpdateInfo?.latest ?? ''} и перезапустить приложение?`
      );
      if (!ok) return;
      setBusy(true);
      try {
        await api.applyAppUpdate();
      } catch (err) {
        reportFailure(err, 'Не удалось установить обновление');
        setBusy(false);
      }
    })();
    return;
  }
  void installAppUpdate();
});

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

els.linkOfficial.addEventListener('click', (e) => {
  e.preventDefault();
  void api.openDownloadPage();
});

els.btnToggle.addEventListener('click', () => {
  if (!currentStatus || busy) return;
  const running = currentStatus.bypass.running;
  void runAction(running ? 'Остановка обхода' : 'Запуск обхода', () =>
    running ? api.stopBypass() : api.startBypass()
  );
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
      '\nZapret App останется на компьютере.',
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
els.strategySelect.addEventListener('change', () => void runAction('Стратегия', () => api.setStrategy(els.strategySelect.value)));
els.gameFilterSelect.addEventListener('change', () => void runAction('Фильтр', () => api.setGameFilter(els.gameFilterSelect.value)));
els.userListKind.addEventListener('change', () => applyUserListEditor(currentUserListKind()));
els.btnUserListSave.addEventListener('click', () => void saveUserListFromEditor());
els.btnUserListAdd.addEventListener('click', () => void addUserListQuick());
els.userListQuickAdd.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    void addUserListQuick();
  }
});
els.ipsetToggle.addEventListener('change', () => {
  const wantLoaded = els.ipsetToggle.checked;
  void (async () => {
    if (busy) {
      els.ipsetToggle.checked = !wantLoaded;
      return;
    }
    setBusy(true);
    try {
      const result = await api.toggleIpset();
      els.ipsetToggle.checked = result.ipset === 'loaded';
      toast(result.ipset === 'loaded' ? 'IPSet включён' : 'IPSet выключен', 'success');
      await refreshStatus();
    } catch (err) {
      els.ipsetToggle.checked = !wantLoaded;
      reportFailure(err);
    } finally {
      setBusy(false);
    }
  })();
});
els.checkUpdatesToggle.addEventListener('change', () => void runAction('Обновления', () => api.setCheckUpdates(els.checkUpdatesToggle.checked)));
els.launchAtStartupToggle.addEventListener('change', () =>
  void runAction('Автозапуск', () => api.setLaunchAtStartup(els.launchAtStartupToggle.checked))
);
els.autoStartBypassToggle.addEventListener('change', () =>
  void runAction('Автозапуск обхода', async () => {
    const result = await api.setAutoStartBypass(els.autoStartBypassToggle.checked);
    if (result.launchAtStartup) {
      els.launchAtStartupToggle.checked = true;
    }
    return result;
  })
);
els.autoPickStrategyToggle.addEventListener('change', () =>
  void runAction('Автоподбор конфига', async () => {
    await api.setAutoPickBestStrategy(els.autoPickStrategyToggle.checked);
    if (els.autoPickStrategyToggle.checked) {
      await maybeStartAutoPick();
    }
  })
);
els.btnDiagnostics.addEventListener('click', () => void runTool('Диагностика', () => api.runDiagnostics()));
els.btnFindBest.addEventListener('click', () => void runPickBestStrategy({ auto: false }));
els.btnCancelStrategyPick.addEventListener('click', () => {
  if (!strategyPickActive) return;
  els.btnCancelStrategyPick.disabled = true;
  els.strategyPickProgressText.textContent = 'Отмена...';
  void api.cancelPickBestStrategy();
});
els.btnTests.addEventListener('click', () =>
  void runTool('Тест текущего конфига', () => api.runTests('current'), { isTest: true })
);
els.testResults.addEventListener('click', (event) => {
  const target = event.target as HTMLElement;
  const row = target.closest<HTMLElement>('[data-strategy]');
  if (!row?.dataset.strategy || busy) return;
  void applyStrategy(row.dataset.strategy);
});
els.btnProcessStatus.addEventListener('click', () => void runTool('Статус обхода', () => api.getProcessStatus()));
els.btnCheckUpdates.addEventListener('click', () => {
  void (async () => {
    if (busy) return;
    setBusy(true);
    try {
      const [zapretUpdate, appUpdate] = await Promise.all([api.checkUpdates(), api.checkAppUpdate()]);
      const zapretMessage = zapretUpdate.upToDate
        ? `Zapret: последняя версия${zapretUpdate.current ? ` (${zapretUpdate.current})` : ''}.`
        : `Zapret: доступна ${zapretUpdate.latest ?? '?'}, сейчас ${zapretUpdate.current ?? '?'}.`;
      const appMessage = appUpdate.upToDate
        ? `Zapret App: последняя версия (v${appUpdate.current}).`
        : `Zapret App: доступна v${appUpdate.latest ?? '?'}, сейчас v${appUpdate.current}.`;
      const message = `${appMessage}\n${zapretMessage}`;

      if (!appUpdate.upToDate && appUpdate.latest) {
        showAppUpdateBanner(appUpdate);
      }

      showInfoModal('Проверка обновлений', message);
      log(message.replace(/\n/g, ' '), appUpdate.upToDate && zapretUpdate.upToDate ? 'success' : 'info');
    } catch (err) {
      reportFailure(err);
    } finally {
      setBusy(false);
    }
  })();
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
els.themeToggle?.addEventListener('click', () => void toggleTheme());

export {};
