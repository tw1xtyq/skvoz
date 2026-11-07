import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron';

export interface DownloadProgress {
  stage: 'fetch' | 'download' | 'extract' | 'install' | 'done' | 'error';
  percent: number;
  message: string;
}

export interface BootstrapState {
  stage: string;
  message: string;
  isOfficial: boolean;
  warnings: string[];
  autoFixed: boolean;
}

contextBridge.exposeInMainWorld('zapretApi', {
  getConfig: () => ipcRenderer.invoke('get-config'),
  getDashboardState: (options?: { light?: boolean; fresh?: boolean }) =>
    ipcRenderer.invoke('get-dashboard-state', options),
  setLaunchAtStartup: (enabled: boolean) => ipcRenderer.invoke('set-launch-at-startup', enabled),
  setAutoStartBypass: (enabled: boolean) => ipcRenderer.invoke('set-auto-start-bypass', enabled),
  setAutoPickBestStrategy: (enabled: boolean) => ipcRenderer.invoke('set-auto-pick-best-strategy', enabled),
  setMinimizeToTray: (enabled: boolean) => ipcRenderer.invoke('set-minimize-to-tray', enabled),
  setAutoUpdateZapret: (enabled: boolean) => ipcRenderer.invoke('set-auto-update-zapret', enabled),
  setBypassAutoRecover: (enabled: boolean) => ipcRenderer.invoke('set-bypass-auto-recover', enabled),
  setBypassAutoSwitch: (enabled: boolean) => ipcRenderer.invoke('set-bypass-auto-switch', enabled),
  setBackgroundRerank: (enabled: boolean) => ipcRenderer.invoke('set-background-rerank', enabled),
  setGameMode: (enabled: boolean) => ipcRenderer.invoke('set-game-mode', enabled),
  setGameProcesses: (names: string[]) => ipcRenderer.invoke('set-game-processes', names),
  setProbeSites: (sites: string[]) => ipcRenderer.invoke('set-probe-sites', sites),
  getBypassActivity: () => ipcRenderer.invoke('get-bypass-activity'),
  saveDiagnosticReport: () => ipcRenderer.invoke('save-diagnostic-report'),
  onBypassActivityChanged: (callback: () => void) => {
    const listener = () => callback();
    ipcRenderer.on('bypass-activity-changed', listener);
    return () => ipcRenderer.removeListener('bypass-activity-changed', listener);
  },
  getBootstrapState: () => ipcRenderer.invoke('get-bootstrap-state'),
  rescanZapret: () => ipcRenderer.invoke('rescan-zapret'),
  scanInstallations: () => ipcRenderer.invoke('scan-installations'),
  setZapretPath: () => ipcRenderer.invoke('set-zapret-path'),
  setStrategy: (strategy: string) => ipcRenderer.invoke('set-strategy', strategy),
  getStatus: () => ipcRenderer.invoke('get-status'),
  getBypassState: () => ipcRenderer.invoke('get-bypass-state'),
  startBypass: () => ipcRenderer.invoke('start-bypass'),
  restartBypass: () => ipcRenderer.invoke('restart-bypass'),
  recoverBypassNow: () => ipcRenderer.invoke('recover-bypass-now'),
  stopBypass: () => ipcRenderer.invoke('stop-bypass'),
  fullRemoveZapret: () => ipcRenderer.invoke('full-remove-zapret'),
  setGameFilter: (mode: string) => ipcRenderer.invoke('set-game-filter', mode),
  toggleIpset: () => ipcRenderer.invoke('toggle-ipset'),
  setIpsetMode: (mode: 'loaded' | 'none' | 'any') => ipcRenderer.invoke('set-ipset-mode', mode),
  updateIpsetList: () => ipcRenderer.invoke('update-ipset-list'),
  updateHostsFile: () => ipcRenderer.invoke('update-hosts-file'),
  listFakeBins: () => ipcRenderer.invoke('list-fake-bins'),
  replaceActiveFake: (type: 'discord' | 'game', fakeFileName: string) =>
    ipcRenderer.invoke('replace-active-fake', type, fakeFileName),
  removeZapretServices: () => ipcRenderer.invoke('remove-zapret-services'),
  getUserLists: () => ipcRenderer.invoke('get-user-lists'),
  saveUserList: (kind: string, content: string) => ipcRenderer.invoke('save-user-list', kind, content),
  addUserListEntries: (kind: string, entries: string[]) =>
    ipcRenderer.invoke('add-user-list-entries', kind, entries),
  setCheckUpdates: (enabled: boolean) => ipcRenderer.invoke('set-check-updates', enabled),
  runDiagnostics: () => ipcRenderer.invoke('run-diagnostics'),
  runTests: (mode: 'current' | 'all' = 'current') => ipcRenderer.invoke('run-tests', mode),
  getAutoPickPending: () => ipcRenderer.invoke('get-auto-pick-pending'),
  runPickBestStrategy: (options?: { quick?: boolean }) => ipcRenderer.invoke('run-pick-best-strategy', options),
  getLastTestResults: () => ipcRenderer.invoke('get-last-test-results'),
  cancelPickBestStrategy: () => ipcRenderer.invoke('cancel-pick-best-strategy'),
  completePostBootstrap: () => ipcRenderer.invoke('complete-post-bootstrap'),
  getProcessStatus: () => ipcRenderer.invoke('get-process-status'),
  checkUpdates: () => ipcRenderer.invoke('check-updates'),
  checkAppUpdate: () => ipcRenderer.invoke('check-app-update'),
  getAppVersion: () => ipcRenderer.invoke('get-app-version'),
  downloadAppUpdate: () => ipcRenderer.invoke('download-app-update'),
  applyAppUpdate: () => ipcRenderer.invoke('apply-app-update'),
  dismissAppUpdate: (version: string) => ipcRenderer.invoke('dismiss-app-update', version),
  openAppReleasePage: () => ipcRenderer.invoke('open-app-release-page'),
  getReleaseInfo: () => ipcRenderer.invoke('get-release-info'),
  downloadZapret: () => ipcRenderer.invoke('download-zapret'),
  openDownloadPage: () => ipcRenderer.invoke('open-download-page'),
  openAppRepo: () => ipcRenderer.invoke('open-app-repo'),

  // ── tg-ws-proxy ────────────────────────────────────────────────────────
  tgwsGetConfig: () => ipcRenderer.invoke('tgws-get-config'),
  tgwsSetConfig: (updates: Record<string, unknown>) =>
    ipcRenderer.invoke('tgws-set-config', updates),
  tgwsStart: () => ipcRenderer.invoke('tgws-start'),
  tgwsStop: () => ipcRenderer.invoke('tgws-stop'),
  tgwsStatus: () => ipcRenderer.invoke('tgws-status'),
  tgwsProxyLink: () => ipcRenderer.invoke('tgws-proxy-link'),

  // ── AmneziaWG VPN ──────────────────────────────────────────────────────
  vpnStatus: () => ipcRenderer.invoke('vpn-status'),
  vpnImportFile: () => ipcRenderer.invoke('vpn-import-file'),
  vpnImportText: (text: string) => ipcRenderer.invoke('vpn-import-text', text),
  vpnRemoveConfig: () => ipcRenderer.invoke('vpn-remove-config'),
  vpnWarpEndpoints: () => ipcRenderer.invoke('vpn-warp-endpoints'),
  vpnGenerateWarp: (options: { endpoint: string; preset: string }) =>
    ipcRenderer.invoke('vpn-generate-warp', options),
  vpnExportConfig: () => ipcRenderer.invoke('vpn-export-config'),
  onVpnProgress: (callback: (payload: { text: string }) => void) => {
    const listener = (_event: IpcRendererEvent, payload: { text: string }) => callback(payload);
    ipcRenderer.on('vpn-progress', listener);
    return () => ipcRenderer.removeListener('vpn-progress', listener);
  },
  vpnConnect: () => ipcRenderer.invoke('vpn-connect'),
  vpnDisconnect: () => ipcRenderer.invoke('vpn-disconnect'),
  vpnSetAutostart: (enabled: boolean) => ipcRenderer.invoke('vpn-set-autostart', enabled),

  checkAccess: () => ipcRenderer.invoke('check-access'),
  showMainWindow: (view?: string) => ipcRenderer.invoke('show-main-window', view),
  onNavigate: (callback: (view: string) => void) => {
    const listener = (_event: IpcRendererEvent, view: string) => callback(view);
    ipcRenderer.on('navigate', listener);
    return () => ipcRenderer.removeListener('navigate', listener);
  },
  openExternal: (url: string) => ipcRenderer.invoke('open-external', url),
  isAdmin: () => ipcRenderer.invoke('is-admin'),
  restartAsAdmin: () => ipcRenderer.invoke('restart-as-admin'),
  onTrayReveal: (callback: () => void) => {
    const listener = () => callback();
    ipcRenderer.on('tray-reveal', listener);
    return () => ipcRenderer.removeListener('tray-reveal', listener);
  },
  onDownloadProgress: (callback: (progress: DownloadProgress) => void) => {
    const listener = (_event: IpcRendererEvent, progress: DownloadProgress) => callback(progress);
    ipcRenderer.on('download-progress', listener);
    return () => ipcRenderer.removeListener('download-progress', listener);
  },
  onToolOutput: (callback: (line: { text: string; level: string }) => void) => {
    const listener = (_event: IpcRendererEvent, line: { text: string; level: string }) => callback(line);
    ipcRenderer.on('tool-output', listener);
    return () => ipcRenderer.removeListener('tool-output', listener);
  },
  onBootstrapStatus: (callback: (state: BootstrapState) => void) => {
    const listener = (_event: IpcRendererEvent, state: BootstrapState) => callback(state);
    ipcRenderer.on('bootstrap-status', listener);
    return () => ipcRenderer.removeListener('bootstrap-status', listener);
  },
  onBootstrapComplete: (callback: (state: BootstrapState) => void) => {
    const listener = (_event: IpcRendererEvent, state: BootstrapState) => callback(state);
    ipcRenderer.on('bootstrap-complete', listener);
    return () => ipcRenderer.removeListener('bootstrap-complete', listener);
  },
  onBypassAutoStarted: (callback: () => void) => {
    const listener = () => callback();
    ipcRenderer.on('bypass-auto-started', listener);
    return () => ipcRenderer.removeListener('bypass-auto-started', listener);
  },
  onBypassWatchdogStopped: (callback: () => void) => {
    const listener = () => callback();
    ipcRenderer.on('bypass-watchdog-stopped', listener);
    return () => ipcRenderer.removeListener('bypass-watchdog-stopped', listener);
  },
  onAutoStartBlocked: (callback: (payload: { reason: 'admin' }) => void) => {
    const listener = (_event: IpcRendererEvent, payload: { reason: 'admin' }) => callback(payload);
    ipcRenderer.on('auto-start-blocked', listener);
    return () => ipcRenderer.removeListener('auto-start-blocked', listener);
  },
  onStrategyAutoPicked: (callback: (payload: {
    strategy: string;
    score: number;
    okChecks: number;
    totalChecks: number;
  }) => void) => {
    const listener = (
      _event: IpcRendererEvent,
      payload: { strategy: string; score: number; okChecks: number; totalChecks: number }
    ) => callback(payload);
    ipcRenderer.on('strategy-auto-picked', listener);
    return () => ipcRenderer.removeListener('strategy-auto-picked', listener);
  },
  onAppWindowVisibility: (callback: (payload: { visible: boolean }) => void) => {
    const listener = (_event: IpcRendererEvent, payload: { visible: boolean }) => callback(payload);
    ipcRenderer.on('app-window-visibility', listener);
    return () => ipcRenderer.removeListener('app-window-visibility', listener);
  },
  onAppUpdateAvailable: (callback: (info: {
    current: string;
    latest: string | null;
    upToDate: boolean;
    releasePage: string | null;
    releaseNotes: string | null;
  }) => void) => {
    const listener = (_event: IpcRendererEvent, info: {
      current: string;
      latest: string | null;
      upToDate: boolean;
      releasePage: string | null;
      releaseNotes: string | null;
    }) => callback(info);
    ipcRenderer.on('app-update-available', listener);
    return () => ipcRenderer.removeListener('app-update-available', listener);
  },
});
