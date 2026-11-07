import { app } from 'electron';
import fs from 'fs';
import path from 'path';
import { getDefaultInstallBase, isInsideAppInstall } from './downloader';

const CONFIG_FILE = 'config.json';
const SETTINGS_REVISION = 2;

export interface AppConfig {
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
  bypassAutoSwitch: boolean;
  /** перепроверять конфиги, пока компьютер простаивает */
  backgroundRerank: boolean;
  /** свои сайты для проверки обхода; пусто — YouTube и Discord из targets.txt */
  probeSites: string[];
  /** пока запущена игра, сторож проверяет сайты реже и не перебирает конфиги */
  gameMode: boolean;
  /** свои exe игр в дополнение к встроенному списку */
  gameProcesses: string[];
  dismissedAppVersion: string | null;
  skipAutoBootstrap: boolean;
  autoUpdateZapret: boolean;
  settingsRevision?: number;
}

function configPath(): string {
  return path.join(app.getPath('userData'), CONFIG_FILE);
}

export function loadConfig(): AppConfig {
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
    bypassAutoSwitch: true,
    backgroundRerank: true,
    probeSites: [],
    gameMode: true,
    gameProcesses: [],
    dismissedAppVersion: null,
    skipAutoBootstrap: false,
    settingsRevision: SETTINGS_REVISION,
    autoUpdateZapret: true,
  };

  try {
    const raw = fs.readFileSync(configPath(), 'utf8');
    const merged: AppConfig = { ...defaults, ...JSON.parse(raw) };
    if (!Array.isArray(merged.probeSites)) merged.probeSites = [];
    if (!Array.isArray(merged.gameProcesses)) merged.gameProcesses = [];
    // Следующие загрузки zapret — вне папки установки; уже скачанный найдётся сканером,
    // а при обновлении zapret переедет в новую папку вместе со списками
    if (isInsideAppInstall(merged.installBase)) merged.installBase = getDefaultInstallBase();
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

export function saveConfig(config: AppConfig): void {
  fs.mkdirSync(path.dirname(configPath()), { recursive: true });
  fs.writeFileSync(configPath(), JSON.stringify(config, null, 2), 'utf8');
}
