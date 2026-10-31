import fs from 'fs';
import path from 'path';
import { runHidden } from './exec';
import { verifyBypassRunning } from './zapret';

const ACTIVE_FAKE_FALLBACKS: Record<string, string[]> = {
  'ACTIVE_DISCORD_UDP.bin': ['stun.bin', 'quic_initial_www_google_com.bin'],
  'ACTIVE_GAME_UDP.bin': ['stun.bin', 'quic_initial_www_google_com.bin'],
};

const REQUIRED_LISTS = [
  'list-general.txt',
  'list-google.txt',
  'list-exclude.txt',
  'ipset-exclude.txt',
  'ipset-all.txt',
];

const BIN_FALLBACKS: Record<string, string> = {
  'stun2.bin': 'tls_clienthello_max_ru.bin',
  'stun.bin': 'quic_initial_www_google_com.bin',
};

export function ensureStrategyBins(root: string): string[] {
  const binDir = path.join(root, 'bin');
  const restored = ensureActiveFakeBins(root);

  for (const [targetName, sourceName] of Object.entries(BIN_FALLBACKS)) {
    const target = path.join(binDir, targetName);
    if (fs.existsSync(target)) continue;
    const source = path.join(binDir, sourceName);
    if (!fs.existsSync(source)) continue;
    fs.copyFileSync(source, target);
    restored.push(targetName);
  }

  return restored;
}

function ensureActiveFakeBins(root: string): string[] {
  const binDir = path.join(root, 'bin');
  const restored: string[] = [];

  for (const [targetName, fallbacks] of Object.entries(ACTIVE_FAKE_FALLBACKS)) {
    const target = path.join(binDir, targetName);
    if (fs.existsSync(target)) continue;

    for (const fallback of fallbacks) {
      const source = path.join(binDir, fallback);
      if (!fs.existsSync(source)) continue;
      fs.copyFileSync(source, target);
      restored.push(targetName);
      break;
    }
  }

  return restored;
}

export function ensureRequiredLists(root: string): void {
  const listsDir = path.join(root, 'lists');
  fs.mkdirSync(listsDir, { recursive: true });

  for (const fileName of REQUIRED_LISTS) {
    const filePath = path.join(listsDir, fileName);
    if (!fs.existsSync(filePath)) {
      fs.writeFileSync(filePath, '', 'utf8');
    }
  }
}

function collectReferencedPaths(args: string[]): string[] {
  const paths: string[] = [];
  for (const arg of args) {
    const cleaned = arg.replace(/^"|"$/g, '');
    if (/^[A-Za-z]:\\/.test(cleaned) && /\.(bin|txt)$/i.test(cleaned)) {
      paths.push(path.normalize(cleaned));
    }
  }
  return paths;
}

export function validateStrategyAssets(args: string[]): void {
  const missing = collectReferencedPaths(args).filter((filePath) => !fs.existsSync(filePath));
  if (missing.length === 0) return;

  const sample = missing.slice(0, 3).map((p) => path.basename(p)).join(', ');
  const suffix = missing.length > 3 ? ` и ещё ${missing.length - 3}` : '';
  throw new Error(`Не хватает файлов стратегии: ${sample}${suffix}`);
}

export async function killWinwsProcesses(): Promise<void> {
  for (const image of ['winws.exe', 'winws1.exe', 'winws2.exe']) {
    try {
      await runHidden('taskkill', ['/IM', image, '/F'], { timeoutMs: 6_000 });
    } catch {
      /* already stopped */
    }
  }
}

export async function ensureWinwsStopped(): Promise<void> {
  await killWinwsProcesses();
  await delay(450);
}

export async function assertWinwsRunningAfterLaunch(timeoutMs = 2_000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const state = await verifyBypassRunning();
    if (state.running) return;
    await delay(350);
  }
  throw new Error(
    'winws.exe сразу завершился: конфиг не подошёл или мешает другая DPI-утилита (GoodbyeDPI, второй zapret). Выберите другой конфиг или нажмите «Подобрать автоматически».'
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
