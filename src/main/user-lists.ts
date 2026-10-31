import fs from 'fs';
import path from 'path';

export type UserListKind = 'general' | 'exclude-domains' | 'exclude-ips';

export interface UserListMeta {
  kind: UserListKind;
  title: string;
  hint: string;
  fileName: string;
}

export interface UserListsPayload {
  lists: Record<UserListKind, string>;
}

const LIST_FILES: Record<UserListKind, string> = {
  general: 'lists/list-general-user.txt',
  'exclude-domains': 'lists/list-exclude-user.txt',
  'exclude-ips': 'lists/ipset-exclude-user.txt',
};

export const USER_LIST_META: UserListMeta[] = [
  {
    kind: 'general',
    title: 'Для обхода',
    hint: 'Домены для обхода — по одному на строку (example.com). Файл не должен быть пустым.',
    fileName: 'list-general-user.txt',
  },
  {
    kind: 'exclude-domains',
    title: 'Исключить домены',
    hint: 'Домены, которые zapret не трогает. Исключения важнее списка обхода.',
    fileName: 'list-exclude-user.txt',
  },
  {
    kind: 'exclude-ips',
    title: 'Исключить IP',
    hint: 'IP или подсеть CIDR (192.168.0.0/24) — не попадут под IPSet-фильтр.',
    fileName: 'ipset-exclude-user.txt',
  },
];

const PLACEHOLDER_LINES = new Set([
  'domain.example.abc',
  '203.0.113.113/32',
]);

function listsDir(root: string): string {
  return path.join(root, 'lists');
}

function listPath(root: string, kind: UserListKind): string {
  return path.join(root, LIST_FILES[kind]);
}

export function ensureUserListFiles(root: string): void {
  const dir = listsDir(root);
  fs.mkdirSync(dir, { recursive: true });

  const general = listPath(root, 'general');
  if (!fs.existsSync(general)) {
    fs.writeFileSync(general, '# Never leave this file empty\ndomain.example.abc\n', 'utf8');
  }

  const excludeDomains = listPath(root, 'exclude-domains');
  if (!fs.existsSync(excludeDomains)) {
    fs.writeFileSync(excludeDomains, 'domain.example.abc\n', 'utf8');
  }

  const excludeIps = listPath(root, 'exclude-ips');
  if (!fs.existsSync(excludeIps)) {
    fs.writeFileSync(excludeIps, '203.0.113.113/32\n', 'utf8');
  }
}

function normalizeLine(line: string): string {
  return line.trim();
}

function isComment(line: string): boolean {
  return line.startsWith('#');
}

export function parseListLines(raw: string): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = normalizeLine(line);
    if (!trimmed || isComment(trimmed)) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(trimmed);
  }

  return result;
}

function isIpv4(value: string): boolean {
  const [ip, mask] = value.split('/');
  const parts = ip.split('.');
  if (parts.length !== 4) return false;
  if (!parts.every((part) => /^\d+$/.test(part) && Number(part) >= 0 && Number(part) <= 255)) {
    return false;
  }
  if (mask === undefined) return true;
  return /^\d+$/.test(mask) && Number(mask) >= 0 && Number(mask) <= 32;
}

function isDomain(value: string): boolean {
  if (value.startsWith('*.')) {
    return /^[*]\.[a-z0-9.-]+\.[a-z]{2,}$/i.test(value) || /^[*]\.[a-z0-9-]+$/i.test(value);
  }
  return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i.test(value);
}

export function validateEntry(kind: UserListKind, entry: string): string | null {
  const value = normalizeLine(entry);
  if (!value) return 'Пустая строка';
  if (isComment(value)) return 'Комментарии не добавляются через форму';

  if (kind === 'exclude-ips') {
    return isIpv4(value) ? null : 'Укажите IP или подсеть CIDR, например 192.168.0.0/24';
  }

  if (isDomain(value) || isIpv4(value)) return null;
  return 'Укажите домен (example.com) или IP (1.2.3.4)';
}

export function readUserLists(root: string): UserListsPayload {
  ensureUserListFiles(root);
  const lists = {} as Record<UserListKind, string>;

  for (const kind of Object.keys(LIST_FILES) as UserListKind[]) {
    lists[kind] = fs.readFileSync(listPath(root, kind), 'utf8');
  }

  return { lists };
}

function formatListContent(kind: UserListKind, entries: string[]): string {
  const body = entries.join('\n');
  if (kind === 'general') {
    // zapret не любит пустой файл — оставляем служебную заглушку
    return `# Пользовательские домены и IP\n${body || 'domain.example.abc'}\n`;
  }
  return body ? `${body}\n` : '';
}

export function saveUserList(root: string, kind: UserListKind, raw: string): UserListsPayload {
  ensureUserListFiles(root);
  const entries = parseListLines(raw).filter((line) => !PLACEHOLDER_LINES.has(line.toLowerCase()));

  for (const entry of entries) {
    const error = validateEntry(kind, entry);
    if (error) throw new Error(`${entry}: ${error}`);
  }

  fs.writeFileSync(listPath(root, kind), formatListContent(kind, entries), 'utf8');
  return readUserLists(root);
}

export function addUserListEntries(
  root: string,
  kind: UserListKind,
  entries: string[]
): { lists: UserListsPayload['lists']; added: string[]; skipped: string[] } {
  ensureUserListFiles(root);
  const current = parseListLines(fs.readFileSync(listPath(root, kind), 'utf8')).filter(
    (line) => !PLACEHOLDER_LINES.has(line.toLowerCase())
  );
  const currentKeys = new Set(current.map((line) => line.toLowerCase()));

  const added: string[] = [];
  const skipped: string[] = [];

  for (const rawEntry of entries) {
    const entry = normalizeLine(rawEntry);
    if (!entry) continue;

    const error = validateEntry(kind, entry);
    if (error) throw new Error(`${entry}: ${error}`);

    const key = entry.toLowerCase();
    if (currentKeys.has(key)) {
      skipped.push(entry);
      continue;
    }

    currentKeys.add(key);
    current.push(entry);
    added.push(entry);
  }

  fs.writeFileSync(listPath(root, kind), formatListContent(kind, current), 'utf8');

  return {
    lists: readUserLists(root).lists,
    added,
    skipped,
  };
}
