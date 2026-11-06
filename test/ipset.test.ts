import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  hasIpsetBackup,
  isIpsetListMissing,
  readIpsetMode,
  saveIpsetList,
  switchIpsetFiles,
  type IpsetMode,
} from '../src/main/ipset-files';
import { restoreIpsetMode } from '../src/main/downloader';

const LIST = '1.1.1.0/24\n2606:4700::/32\n';
const PLACEHOLDER = '203.0.113.113/32\r\n';

function withLists(run: (dir: string) => void, list: string | null = PLACEHOLDER, backup: string | null = LIST): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skvoz-ipset-'));
  const dir = path.join(root, 'lists');
  fs.mkdirSync(dir);
  if (list !== null) fs.writeFileSync(path.join(dir, 'ipset-all.txt'), list);
  if (backup !== null) fs.writeFileSync(path.join(dir, 'ipset-all.txt.backup'), backup);
  try {
    run(dir);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const readList = (dir: string): string => fs.readFileSync(path.join(dir, 'ipset-all.txt'), 'utf8');
const readBackup = (dir: string): string => fs.readFileSync(path.join(dir, 'ipset-all.txt.backup'), 'utf8');

test('заглушка с CRLF читается как none', () => {
  withLists((dir) => assert.equal(readIpsetMode(dir), 'none'));
});

test('любая цепочка переключений сохраняет список', () => {
  const chains: IpsetMode[][] = [
    ['loaded', 'any', 'loaded'],
    ['any', 'none', 'loaded'],
    ['loaded', 'none', 'any', 'loaded'],
    ['any', 'loaded', 'none', 'loaded'],
    ['none', 'any', 'none', 'any', 'loaded'],
  ];
  for (const chain of chains) {
    withLists((dir) => {
      for (const mode of chain) assert.equal(switchIpsetFiles(dir, mode), mode);
      assert.equal(readList(dir), LIST);
    });
  }
});

test('из loaded без копии список уходит в копию', () => {
  for (const mode of ['none', 'any'] as const) {
    withLists(
      (dir) => {
        assert.equal(switchIpsetFiles(dir, mode), mode);
        assert.equal(readBackup(dir), LIST);
      },
      LIST,
      null
    );
  }
});

test('список заменяет устаревшую копию', () => {
  withLists(
    (dir) => {
      switchIpsetFiles(dir, 'none');
      assert.equal(readBackup(dir), LIST);
    },
    LIST,
    '9.9.9.0/24\n'
  );
});

test('пустая копия не считается копией, файлы не меняются', () => {
  withLists(
    (dir) => {
      assert.equal(hasIpsetBackup(dir), false);
      assert.equal(isIpsetListMissing(dir), true);
      assert.throws(() => switchIpsetFiles(dir, 'loaded'), /Нет сохранённого списка/);
      assert.equal(readList(dir), PLACEHOLDER);
      assert.equal(readBackup(dir), '');
    },
    PLACEHOLDER,
    ''
  );
});

test('новый список вне loaded ждёт в копии и не меняет режим', () => {
  for (const [list, mode] of [[PLACEHOLDER, 'none'], ['', 'any']] as const) {
    withLists((dir) => {
      assert.equal(saveIpsetList(dir, '8.8.8.0/24\r\n'), mode);
      assert.equal(readIpsetMode(dir), mode);
      assert.equal(readBackup(dir), '8.8.8.0/24\n');
    }, list);
  }
});

test('в режиме loaded новый список заменяет текущий', () => {
  withLists(
    (dir) => {
      assert.equal(saveIpsetList(dir, '8.8.8.0/24\n'), 'loaded');
      assert.equal(readList(dir), '8.8.8.0/24\n');
    },
    LIST,
    null
  );
});

test('мусор и пустой ответ не трогают файлы', () => {
  for (const content of ['', '  \n', '<html>404</html>', '203.0.113.113/32\n']) {
    withLists((dir) => {
      assert.throws(() => saveIpsetList(dir, content), /пуст или повреждён/);
      assert.equal(readList(dir), PLACEHOLDER);
      assert.equal(readBackup(dir), LIST);
    });
  }
});

test('после обновления zapret режим IPSet возвращается', () => {
  withLists((dir) => {
    restoreIpsetMode(path.dirname(dir), 'loaded');
    assert.equal(readIpsetMode(dir), 'loaded');
    assert.equal(readList(dir), LIST);
  });
});

test('без копии в новой папке установка не падает', () => {
  withLists(
    (dir) => {
      assert.doesNotThrow(() => restoreIpsetMode(path.dirname(dir), 'loaded'));
      assert.equal(readIpsetMode(dir), 'none');
    },
    PLACEHOLDER,
    null
  );
});

test('список с посторонней строкой отклоняется, BOM и пробелы допустимы', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skvoz-ipset-list-'));
  try {
    fs.writeFileSync(path.join(dir, 'ipset-all.txt'), '');
    assert.throws(() => saveIpsetList(dir, 'Not Found\n1.2.3.0/24\n'), /повреждён/);
    assert.equal(fs.existsSync(path.join(dir, 'ipset-all.txt.backup')), false);
    saveIpsetList(dir, '\uFEFF1.2.3.0/24 \r\n2001:db8::/32\r\n');
    assert.equal(fs.readFileSync(path.join(dir, 'ipset-all.txt.backup'), 'utf8'), '1.2.3.0/24\n2001:db8::/32\n');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
