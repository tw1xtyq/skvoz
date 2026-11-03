import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseModuleHolders, parseScState } from '../src/main/diagnostics';

const SC_RUNNING = `
SERVICE_NAME: WinDivert
        TYPE               : 1  KERNEL_DRIVER
        STATE              : 4  RUNNING
                                (STOPPABLE, NOT_PAUSABLE, IGNORES_SHUTDOWN)
        WIN32_EXIT_CODE    : 0  (0x0)
`;

test('состояние службы берётся из STATE, а не из TYPE', () => {
  assert.equal(parseScState(SC_RUNNING), 'running');
  assert.equal(parseScState(SC_RUNNING.replace('4  RUNNING', '1  STOPPED')), 'stopped');
  assert.equal(parseScState(SC_RUNNING.replace('4  RUNNING', '3  STOP_PENDING')), 'stopping');
});

test('нет службы — 1060 на любом языке', () => {
  assert.equal(parseScState('[SC] EnumQueryServicesStatus:OpenService FAILED 1060:\n\nThe specified service does not exist'), 'missing');
  assert.equal(parseScState('[SC] EnumQueryServicesStatus:OpenService: ошибка: 1060:\n\nУказанная служба не установлена.'), 'missing');
});

test('процессы, держащие WinDivert.dll', () => {
  const csv = '"goodbyedpi.exe","4120","WinDivert.dll"\r\n"goodbyedpi.exe","4188","WinDivert.dll"\r\n';
  assert.deepEqual(parseModuleHolders(csv), ['goodbyedpi.exe']);
  assert.deepEqual(parseModuleHolders('INFO: No tasks are running which match the specified criteria.'), []);
  assert.deepEqual(parseModuleHolders('ИНФОРМАЦИЯ: задачи, отвечающие заданным критериям, отсутствуют.'), []);
});
