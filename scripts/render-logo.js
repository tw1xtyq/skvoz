// Рендерит assets/logo.svg в PNG для иконки приложения и интерфейса.
// Запуск: npm run logo (нужен Electron, обычный node SVG не растеризует).
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const svg = fs.readFileSync(path.join(root, 'assets', 'logo.svg'), 'utf8');
const SIZE = 1024;
const targets = [path.join(root, 'assets', 'icon.png'), path.join(root, 'src', 'renderer', 'assets', 'logo.png')];

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: SIZE,
    height: SIZE,
    show: false,
    transparent: true,
    frame: false,
    useContentSize: true,
    webPreferences: { offscreen: true },
  });
  const html = `<html><body style="margin:0;background:transparent">${svg.replace(
    '<svg ',
    `<svg width="${SIZE}" height="${SIZE}" `
  )}</body></html>`;
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  await new Promise((resolve) => setTimeout(resolve, 300));
  const image = await win.webContents.capturePage({ x: 0, y: 0, width: SIZE, height: SIZE });
  const png = image.resize({ width: SIZE, height: SIZE, quality: 'best' }).toPNG();
  for (const target of targets) {
    fs.writeFileSync(target, png);
    console.log(`Rendered ${path.relative(root, target)}`);
  }
  app.quit();
});
