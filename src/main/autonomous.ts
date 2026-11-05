import fs from 'fs';
import {
  downloadOfficialZapret,
  fetchLatestRelease,
  getDefaultInstallBase,
  getInstallPath,
  type DownloadProgress,
} from './downloader';
import { scanForInstallations, type InstallCandidate, type ScanResult } from './scanner';

export type BootstrapStage =
  | 'scanning'
  | 'found-official'
  | 'found-unofficial'
  | 'not-found'
  | 'downloading'
  | 'updating'
  | 'ready'
  | 'error';

export interface BootstrapState {
  stage: BootstrapStage;
  message: string;
  scan: ScanResult | null;
  selected: InstallCandidate | null;
  isOfficial: boolean;
  warnings: string[];
  autoFixed: boolean;
}

export type BootstrapCallback = (state: BootstrapState) => void;

function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

export async function runAutonomousBootstrap(
  currentPath: string | undefined,
  installBase: string,
  onProgress: BootstrapCallback,
  onDownloadProgress?: (progress: DownloadProgress) => void
): Promise<{ path: string; state: BootstrapState }> {
  onProgress({
    stage: 'scanning',
    message: 'Поиск zapret на компьютере...',
    scan: null,
    selected: null,
    isOfficial: false,
    warnings: [],
    autoFixed: false,
  });

  const scan = await scanForInstallations(currentPath ? [currentPath] : [], installBase);
  const best = scan.best;

  if (!best) {
    onProgress({
      stage: 'downloading',
      message: 'Загрузка официального zapret с GitHub...',
      scan,
      selected: null,
      isOfficial: false,
      warnings: [],
      autoFixed: false,
    });

    try {
      const download = await downloadOfficialZapret(installBase, null, onDownloadProgress ?? (() => undefined));
      const ready: BootstrapState = {
        stage: 'ready',
        message: `Установлен zapret ${download.version}`,
        scan,
        selected: {
          path: download.installPath,
          version: download.version,
          isOfficial: true,
          score: 100,
          source: 'auto-download',
          warnings: [],
        },
        isOfficial: true,
        warnings: [],
        autoFixed: true,
      };
      onProgress(ready);
      return { path: download.installPath, state: ready };
    } catch (err) {
      throw new Error(`Zapret не найден и загрузка не удалась: ${err instanceof Error ? err.message : err}`);
    }
  }

  if (!best.isOfficial) {
    onProgress({
      stage: 'found-unofficial',
      message: `Неофициальная сборка. Попытка замены...`,
      scan,
      selected: best,
      isOfficial: false,
      warnings: best.warnings,
      autoFixed: false,
    });

    try {
      const download = await downloadOfficialZapret(installBase, best.path, onDownloadProgress ?? (() => undefined));
      const ready: BootstrapState = {
        stage: 'ready',
        message: 'Заменено на официальную версию',
        scan,
        selected: {
          path: download.installPath,
          version: download.version,
          isOfficial: true,
          score: 100,
          source: 'auto-replace-unofficial',
          warnings: [],
        },
        isOfficial: true,
        warnings: ['Была найдена неофициальная сборка'],
        autoFixed: true,
      };
      onProgress(ready);
      return { path: download.installPath, state: ready };
    } catch {
      const fallback: BootstrapState = {
        stage: 'ready',
        message: 'Используется найденная сборка (загрузка недоступна)',
        scan,
        selected: best,
        isOfficial: false,
        warnings: [...best.warnings, 'Не удалось скачать официальную версию'],
        autoFixed: false,
      };
      onProgress(fallback);
      return { path: best.path, state: fallback };
    }
  }

  let latestVersion: string | null = null;
  try {
    latestVersion = (await fetchLatestRelease()).version;
  } catch {
    latestVersion = null;
  }

  const needsUpdate =
    !!latestVersion && !!best.version && compareVersions(best.version, latestVersion) < 0;

  if (needsUpdate && latestVersion) {
    onProgress({
      stage: 'updating',
      message: `Обновление ${best.version} → ${latestVersion}...`,
      scan,
      selected: best,
      isOfficial: true,
      warnings: [],
      autoFixed: false,
    });

    try {
      const download = await downloadOfficialZapret(installBase, best.path, onDownloadProgress ?? (() => undefined));
      const ready: BootstrapState = {
        stage: 'ready',
        message: `Обновлено до ${download.version}`,
        scan,
        selected: {
          path: download.installPath,
          version: download.version,
          isOfficial: true,
          score: best.score,
          source: 'auto-update',
          warnings: [],
        },
        isOfficial: true,
        warnings: [],
        autoFixed: true,
      };
      onProgress(ready);
      return { path: download.installPath, state: ready };
    } catch {
      const ready: BootstrapState = {
        stage: 'ready',
        message: `Используется ${best.version} (обновление недоступно)`,
        scan,
        selected: best,
        isOfficial: true,
        warnings: ['Не удалось скачать обновление'],
        autoFixed: false,
      };
      onProgress(ready);
      return { path: best.path, state: ready };
    }
  }

  const officialPath =
    fs.existsSync(best.path) ? best.path : getInstallPath(installBase, best.version ?? 'latest');

  onProgress({
    stage: 'found-official',
    message: `Найден официальный zapret ${best.version ?? ''}`.trim(),
    scan,
    selected: best,
    isOfficial: true,
    warnings: [],
    autoFixed: false,
  });

  const ready: BootstrapState = {
    stage: 'ready',
    message: 'Официальная версия готова к работе',
    scan,
    selected: best,
    isOfficial: true,
    warnings: [],
    autoFixed: false,
  };
  onProgress(ready);
  return { path: best.path, state: ready };
}
