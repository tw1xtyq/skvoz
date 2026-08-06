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
  getDashboardState: (options?: { light?: boolean }) => ipcRenderer.invoke('get-dashboard-state', options),
  setTheme: (theme: 'dark' | 'light') => ipcRenderer.invoke('set-theme', theme),
  setLaunchAtStartup: (enabled: boolean) => ipcRenderer.invoke('set-launch-at-startup', enabled),
  setAutoStartBypass: (enabled: boolean) => ipcRenderer.invoke('set-auto-start-bypass', enabled),
  setAutoPickBestStrategy: (enabled: boolean) => ipcRenderer.invoke('set-auto-pick-best-strategy', enabled),
  getBootstrapState: () => ipcRenderer.invoke('get-bootstrap-state'),
  rescanZapret: () => ipcRenderer.invoke('rescan-zapret'),
  scanInstallations: () => ipcRenderer.invoke('scan-installations'),
  setZapretPath: () => ipcRenderer.invoke('set-zapret-path'),
  setStrategy: (strategy: string) => ipcRenderer.invoke('set-strategy', strategy),
  getStatus: () => ipcRenderer.invoke('get-status'),
  startBypass: () => ipcRenderer.invoke('start-bypass'),
  stopBypass: () => ipcRenderer.invoke('stop-bypass'),
  fullRemoveZapret: () => ipcRenderer.invoke('full-remove-zapret'),
  setGameFilter: (mode: string) => ipcRenderer.invoke('set-game-filter', mode),
  toggleIpset: () => ipcRenderer.invoke('toggle-ipset'),
  getUserLists: () => ipcRenderer.invoke('get-user-lists'),
  saveUserList: (kind: string, content: string) => ipcRenderer.invoke('save-user-list', kind, content),
  addUserListEntries: (kind: string, entries: string[]) =>
    ipcRenderer.invoke('add-user-list-entries', kind, entries),
  setCheckUpdates: (enabled: boolean) => ipcRenderer.invoke('set-check-updates', enabled),
  runDiagnostics: () => ipcRenderer.invoke('run-diagnostics'),
  runTests: (mode: 'current' | 'all' = 'current') => ipcRenderer.invoke('run-tests', mode),
  getAutoPickPending: () => ipcRenderer.invoke('get-auto-pick-pending'),
  runPickBestStrategy: () => ipcRenderer.invoke('run-pick-best-strategy'),
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
  isAdmin: () => ipcRenderer.invoke('is-admin'),
  restartAsAdmin: () => ipcRenderer.invoke('restart-as-admin'),
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
