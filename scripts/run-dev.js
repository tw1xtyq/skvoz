const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const projectRoot = path.join(__dirname, '..');
const electronDir = path.dirname(require('electron'));
const sourceExe = path.join(electronDir, 'electron.exe');
const devExe = path.join(electronDir, 'Zapret App.exe');

function ensureDevExecutable() {
  if (!fs.existsSync(sourceExe)) {
    throw new Error(`Не найден Electron: ${sourceExe}`);
  }

  const needsCopy =
    !fs.existsSync(devExe) ||
    fs.statSync(sourceExe).mtimeMs > fs.statSync(devExe).mtimeMs;

  if (needsCopy) {
    fs.copyFileSync(sourceExe, devExe);
  }
}

ensureDevExecutable();

const child = spawn(devExe, ['.'], {
  cwd: projectRoot,
  stdio: 'inherit',
  windowsHide: false,
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});

child.on('error', (error) => {
  console.error(error.message);
  process.exit(1);
});
