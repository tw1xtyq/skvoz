import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { loadLogProblems, saveLogProblems } from '../src/main/tool-log';

function withTempFile(run: (filePath: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skvoz-log-'));
  try {
    run(path.join(dir, 'tool-errors.json'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('после перезапуска в журнале остаются только сбои', () => {
  withTempFile((file) => {
    saveLogProblems(file, [
      { at: 1, level: 'info', text: 'запуск' },
      { at: 2, level: 'error', text: 'Не удалось распаковать архив' },
      { at: 3, level: 'warn', text: 'Автообновление zapret не удалось' },
    ]);
    assert.deepEqual(
      loadLogProblems(file).map((line) => line.text),
      ['Не удалось распаковать архив', 'Автообновление zapret не удалось']
    );
  });
});

test('хранятся последние 50 сбоев', () => {
  withTempFile((file) => {
    const log = Array.from({ length: 60 }, (_, at) => ({ at, level: 'error', text: `сбой ${at}` }));
    saveLogProblems(file, log);
    const saved = loadLogProblems(file);
    assert.equal(saved.length, 50);
    assert.equal(saved[0].text, 'сбой 10');
  });
});

test('нет файла или он повреждён — журнал пуст', () => {
  withTempFile((file) => {
    assert.deepEqual(loadLogProblems(file), []);
    fs.writeFileSync(file, '{oops');
    assert.deepEqual(loadLogProblems(file), []);
  });
});
