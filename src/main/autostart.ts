import { app } from 'electron';
import path from 'path';
import { runHidden } from './exec';

const AUTOSTART_TASK_NAME = 'ZapretAppAutostart';
export const STARTUP_LAUNCH_ARG = '--startup';

export function isStartupLaunch(): boolean {
  return process.argv.includes(STARTUP_LAUNCH_ARG);
}

function useWindowsScheduledTask(): boolean {
  return process.platform === 'win32' && app.isPackaged;
}

function execPath(): string {
  return process.execPath;
}

async function isScheduledTaskRegistered(): Promise<boolean> {
  const code = await runHidden('schtasks.exe', ['/Query', '/TN', AUTOSTART_TASK_NAME]);
  return code === 0;
}

async function registerScheduledTask(): Promise<void> {
  const exe = execPath();
  const code = await runHidden('schtasks.exe', [
    '/Create',
    '/TN',
    AUTOSTART_TASK_NAME,
    '/TR',
    `"${exe}" ${STARTUP_LAUNCH_ARG}`,
    '/SC',
    'ONLOGON',
    '/RL',
    'HIGHEST',
    '/F',
  ]);
  if (code !== 0) {
    throw new Error('Не удалось создать задачу автозапуска в планировщике Windows');
  }
}

async function unregisterScheduledTask(): Promise<void> {
  const code = await runHidden('schtasks.exe', ['/Delete', '/TN', AUTOSTART_TASK_NAME, '/F']);
  if (code !== 0 && (await isScheduledTaskRegistered())) {
    throw new Error('Не удалось удалить задачу автозапуска из планировщика Windows');
  }
}

function clearElectronLoginItem(): void {
  try {
    app.setLoginItemSettings({ openAtLogin: false });
  } catch {
    /* ignore */
  }
}

function applyElectronLoginItem(enabled: boolean): void {
  const settings: {
    openAtLogin: boolean;
    path?: string;
    args?: string[];
  } = {
    openAtLogin: enabled,
  };

  if (process.platform === 'win32') {
    settings.path = execPath();
    if (!app.isPackaged && process.argv[1]) {
      settings.args = [path.resolve(process.argv[1])];
    }
  }

  app.setLoginItemSettings(settings);
}

export async function isLaunchAtStartupEnabled(): Promise<boolean> {
  if (useWindowsScheduledTask()) {
    return isScheduledTaskRegistered();
  }

  try {
    return app.getLoginItemSettings().openAtLogin;
  } catch {
    return false;
  }
}

export async function applyLaunchAtStartup(enabled: boolean): Promise<void> {
  if (process.platform !== 'win32' && process.platform !== 'darwin' && process.platform !== 'linux') {
    return;
  }

  if (useWindowsScheduledTask()) {
    if (enabled) {
      clearElectronLoginItem();
      await registerScheduledTask();
    } else {
      await unregisterScheduledTask();
      clearElectronLoginItem();
    }
    return;
  }

  applyElectronLoginItem(enabled);
}

export async function syncLaunchAtStartup(enabled: boolean): Promise<void> {
  if (!enabled) {
    if (await isLaunchAtStartupEnabled()) {
      await applyLaunchAtStartup(false);
    }
    return;
  }

  await applyLaunchAtStartup(true);
}
