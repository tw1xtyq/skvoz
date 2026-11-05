import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { shell } from 'electron';
import { assertAdmin } from './admin';
import { httpFetch } from './http';
import type { OutputCallback } from './diagnostics';
import { shutdownZapretCompletely } from './uninstall';

export type IpsetMode = 'loaded' | 'none' | 'any';

const IPSET_URL =
  'https://raw.githubusercontent.com/Flowseal/zapret-discord-youtube/refs/heads/main/.service/ipset-service.txt';
const HOSTS_URL =
  'https://raw.githubusercontent.com/Flowseal/zapret-discord-youtube/refs/heads/main/.service/hosts';
const PLACEHOLDER_IP = '203.0.113.113/32';

export function readIpsetMode(listsDir: string): IpsetMode {
  const listFile = path.join(listsDir, 'ipset-all.txt');
  if (!fs.existsSync(listFile)) return 'any';

  const content = fs.readFileSync(listFile, 'utf8').trim();
  if (!content) return 'any';
  if (content === PLACEHOLDER_IP) return 'none';
  return 'loaded';
}

export function setIpsetMode(root: string, mode: IpsetMode): IpsetMode {
  assertAdmin();
  const listsDir = path.join(root, 'lists');
  const listFile = path.join(listsDir, 'ipset-all.txt');
  const backupFile = `${listFile}.backup`;

  fs.mkdirSync(listsDir, { recursive: true });
  const current = readIpsetMode(listsDir);

  if (mode === current) {
    return current;
  }

  if (mode === 'none') {
    if (fs.existsSync(listFile)) {
      if (fs.existsSync(backupFile)) fs.unlinkSync(backupFile);
      fs.renameSync(listFile, backupFile);
    }
    fs.writeFileSync(listFile, `${PLACEHOLDER_IP}\n`, 'utf8');
  } else if (mode === 'any') {
    fs.writeFileSync(listFile, '', 'utf8');
  } else {
    if (!fs.existsSync(backupFile)) {
      throw new Error('Нет резервной копии IPSet. Сначала Update IPSet List (service.bat, п. 8).');
    }
    if (fs.existsSync(listFile)) fs.unlinkSync(listFile);
    fs.renameSync(backupFile, listFile);
  }

  return readIpsetMode(listsDir);
}

export function hasIpsetBackup(listsDir: string): boolean {
  return fs.existsSync(path.join(listsDir, 'ipset-all.txt.backup'));
}

async function downloadText(url: string, timeoutMs = 20_000): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await httpFetch(url, {
      headers: { 'User-Agent': 'zapret-app' },
      redirect: 'follow',
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    return await response.text();
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error('Превышено время ожидания загрузки. Проверьте интернет и повторите.');
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export async function updateIpsetList(root: string, out?: OutputCallback): Promise<void> {
  assertAdmin();
  const listsDir = path.join(root, 'lists');
  const listFile = path.join(listsDir, 'ipset-all.txt');
  const backupFile = `${listFile}.backup`;

  out?.({ text: 'Загрузка списка IPSet...', level: 'info' });
  const content = await downloadText(IPSET_URL);

  fs.mkdirSync(listsDir, { recursive: true });
  if (fs.existsSync(listFile) && readIpsetMode(listsDir) === 'loaded') {
    fs.copyFileSync(listFile, backupFile);
  }
  fs.writeFileSync(listFile, content.replace(/\r?\n/g, '\n').trimEnd() + '\n', 'utf8');
  out?.({ text: '[OK] lists/ipset-all.txt обновлён', level: 'success' });
}

function systemHostsPath(): string {
  return path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'drivers', 'etc', 'hosts');
}

export async function updateHostsFile(out?: OutputCallback): Promise<{
  upToDate: boolean;
  tempPath: string | null;
  hostsPath: string;
  message: string;
}> {
  assertAdmin();
  const hostsPath = systemHostsPath();
  out?.({ text: 'Проверка hosts...', level: 'info' });

  const remote = await downloadText(HOSTS_URL);
  const lines = remote
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length < 2) {
    throw new Error('Файл hosts с GitHub пуст или повреждён');
  }

  const firstLine = lines[0];
  const lastLine = lines[lines.length - 1];
  let local = '';
  try {
    local = fs.readFileSync(hostsPath, 'utf8');
  } catch {
    local = '';
  }

  const upToDate = local.includes(firstLine) && local.includes(lastLine);
  if (upToDate) {
    const message = 'Файл hosts уже актуален';
    out?.({ text: `[OK] ${message}`, level: 'success' });
    return { upToDate: true, tempPath: null, hostsPath, message };
  }

  const tempPath = path.join(os.tmpdir(), `zapret-hosts-${Date.now()}.txt`);
  fs.writeFileSync(tempPath, remote, 'utf8');

  await shell.openPath(tempPath);
  await shell.showItemInFolder(hostsPath);

  const message =
    'Hosts нужно обновить вручную: скопируйте содержимое открытого файла в системный hosts от администратора.';
  out?.({ text: message, level: 'warn' });
  return { upToDate: false, tempPath, hostsPath, message };
}

function hashFile(filePath: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex').toUpperCase();
}

export interface FakeBinInfo {
  name: string;
  fileName: string;
}

export interface ActiveFakesInfo {
  fakes: FakeBinInfo[];
  discordActive: string | null;
  gameActive: string | null;
}

export function listFakeBins(root: string): ActiveFakesInfo {
  const binDir = path.join(root, 'bin');
  if (!fs.existsSync(binDir)) {
    return { fakes: [], discordActive: null, gameActive: null };
  }

  const fakes: FakeBinInfo[] = [];
  let discordHash: string | null = null;
  let gameHash: string | null = null;

  const discordActive = path.join(binDir, 'ACTIVE_DISCORD_UDP.bin');
  const gameActive = path.join(binDir, 'ACTIVE_GAME_UDP.bin');
  if (fs.existsSync(discordActive)) discordHash = hashFile(discordActive);
  if (fs.existsSync(gameActive)) gameHash = hashFile(gameActive);

  for (const entry of fs.readdirSync(binDir)) {
    if (!entry.toLowerCase().endsWith('.bin')) continue;
    if (entry.toUpperCase().startsWith('ACTIVE_')) continue;
    fakes.push({ name: path.parse(entry).name, fileName: entry });
  }

  fakes.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));

  let discordActiveName: string | null = null;
  let gameActiveName: string | null = null;

  for (const fake of fakes) {
    const fakePath = path.join(binDir, fake.fileName);
    const hash = hashFile(fakePath);
    if (discordHash && hash === discordHash) discordActiveName = fake.name;
    if (gameHash && hash === gameHash) gameActiveName = fake.name;
  }

  return {
    fakes,
    discordActive: discordActiveName,
    gameActive: gameActiveName,
  };
}

export function replaceActiveFake(root: string, type: 'discord' | 'game', fakeFileName: string): string {
  assertAdmin();
  const binDir = path.join(root, 'bin');
  const source = path.join(binDir, fakeFileName);
  if (!fs.existsSync(source)) {
    throw new Error(`Файл не найден: ${fakeFileName}`);
  }

  const targetName = type === 'discord' ? 'ACTIVE_DISCORD_UDP.bin' : 'ACTIVE_GAME_UDP.bin';
  const target = path.join(binDir, targetName);
  fs.copyFileSync(source, target);
  return path.parse(fakeFileName).name;
}

export async function removeWindowsServices(out?: OutputCallback): Promise<void> {
  await shutdownZapretCompletely(out ?? (() => undefined));
}
