import fs from 'fs';
import path from 'path';

export type IpsetMode = 'loaded' | 'none' | 'any';

const PLACEHOLDER_IP = '203.0.113.113/32';
const LIST_FILE = 'ipset-all.txt';
const BACKUP_FILE = `${LIST_FILE}.backup`;

function classifyIpsetText(text: string): IpsetMode {
  const content = text.trim();
  if (!content) return 'any';
  return content === PLACEHOLDER_IP ? 'none' : 'loaded';
}

export function readIpsetMode(listsDir: string): IpsetMode {
  const listFile = path.join(listsDir, LIST_FILE);
  if (!fs.existsSync(listFile)) return 'any';
  return classifyIpsetText(fs.readFileSync(listFile, 'utf8'));
}

/** Пустая копия или заглушка — не копия: такие оставляли прежние версии Skvoz */
export function hasIpsetBackup(listsDir: string): boolean {
  const backupFile = path.join(listsDir, BACKUP_FILE);
  return fs.existsSync(backupFile) && classifyIpsetText(fs.readFileSync(backupFile, 'utf8')) === 'loaded';
}

/** Настоящего списка нет ни на месте, ни в копии — включить режим loaded нечем */
export function isIpsetListMissing(listsDir: string): boolean {
  return readIpsetMode(listsDir) !== 'loaded' && !hasIpsetBackup(listsDir);
}

function isFileLocked(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === 'EPERM' || code === 'EBUSY' || code === 'EACCES';
}

export function switchIpsetFiles(listsDir: string, mode: IpsetMode): IpsetMode {
  const listFile = path.join(listsDir, LIST_FILE);
  const backupFile = path.join(listsDir, BACKUP_FILE);

  fs.mkdirSync(listsDir, { recursive: true });
  const current = readIpsetMode(listsDir);
  if (mode === current) return current;

  if (mode === 'loaded' && !hasIpsetBackup(listsDir)) {
    throw new Error('Нет сохранённого списка IPSet. Нажмите «Обновить» в разделе «Обновления» → «Список IPSet».');
  }

  try {
    if (mode === 'loaded') {
      fs.renameSync(backupFile, listFile);
    } else {
      // В копию попадает только настоящий список, иначе заглушка затрёт его
      if (current === 'loaded') fs.renameSync(listFile, backupFile);
      fs.writeFileSync(listFile, mode === 'none' ? `${PLACEHOLDER_IP}\n` : '', 'utf8');
    }
  } catch (error) {
    if (!isFileLocked(error)) throw error;
    throw new Error('Файл списка IPSet занят другим процессом. Проверьте антивирус и повторите.');
  }

  return readIpsetMode(listsDir);
}

/** Новый список не меняет режим: вне loaded он ждёт в копии. Возвращает текущий режим */
export function saveIpsetList(listsDir: string, content: string): IpsetMode {
  const lines = content.replace(/^﻿/, '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const text = `${lines.join('\n')}\n`;
  if (classifyIpsetText(text) !== 'loaded' || !lines.every((line) => /^[\da-f:.]+(\/\d+)?$/i.test(line))) {
    throw new Error('Список IPSet с GitHub пуст или повреждён');
  }

  fs.mkdirSync(listsDir, { recursive: true });
  const mode = readIpsetMode(listsDir);
  fs.writeFileSync(path.join(listsDir, mode === 'loaded' ? LIST_FILE : BACKUP_FILE), text, 'utf8');
  return mode;
}
