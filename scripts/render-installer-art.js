// Рисует картинки установщика NSIS в стиле логотипа: боковую панель страниц
// «Добро пожаловать» / «Готово» (164×314) и шапку остальных страниц (150×57).
// Запуск: npm run installer-art (нужен Electron — обычный node HTML не растеризует).
// NSIS принимает только BMP, поэтому пишем 24-битный BMP сами.
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const outDir = path.join(root, 'assets');
const logo = fs.readFileSync(path.join(root, 'assets', 'logo.svg'), 'utf8');
const logoUri = `data:image/svg+xml;base64,${Buffer.from(logo).toString('base64')}`;

// Рисуем вдвое крупнее и уменьшаем — так у текста и луча чистые края
const SCALE = 2;

const FONT = `'Segoe UI Variable Display', 'Segoe UI', sans-serif`;
const WORDMARK = `
  font: 700 24px/1 ${FONT};
  letter-spacing: -0.02em;
  background: linear-gradient(90deg, #9a86ff, #3cd2f7);
  -webkit-background-clip: text;
  color: transparent;
`;

function sidebarHtml(caption) {
  return `
  <div class="art">
    <div class="halo"></div>
    <div class="beam"></div>
    <img class="logo" src="${logoUri}">
    <div class="name">Skvoz</div>
    <div class="caption">${caption}</div>
    <ul class="features">
      <li><i></i>Обход блокировок</li>
      <li><i></i>Telegram-прокси</li>
      <li><i></i>VPN на AmneziaWG</li>
    </ul>
  </div>
  <style>
    .art {
      position: relative; width: 164px; height: 314px; overflow: hidden;
      background: linear-gradient(160deg, #1c1742 0%, #0d0f22 55%, #070915 100%);
      font-family: ${FONT}; color: #eceef3;
      display: flex; flex-direction: column; align-items: center;
    }
    .halo {
      position: absolute; left: 50%; top: 74px; width: 220px; height: 220px;
      transform: translate(-50%, -50%);
      background: radial-gradient(circle, rgba(111, 92, 255, 0.42), rgba(111, 92, 255, 0) 65%);
    }
    .beam {
      position: absolute; left: -20px; right: -20px; bottom: 28px; height: 1px;
      background: linear-gradient(90deg, rgba(154, 134, 255, 0), rgba(154, 134, 255, 0.55), rgba(60, 210, 247, 0));
    }
    .logo { position: relative; width: 76px; height: 76px; margin-top: 36px; }
    .name { position: relative; margin-top: 14px; ${WORDMARK} }
    .caption {
      position: relative; margin-top: 8px; padding: 0 14px;
      font: 500 9.5px/1.45 ${FONT}; color: #a1a6b3; text-align: center;
    }
    .features {
      position: relative; list-style: none; margin: 22px 0 0; padding: 0;
      font: 500 9.5px/1 ${FONT}; color: #c9ccd6;
    }
    .features li { display: flex; align-items: center; gap: 7px; margin-top: 9px; }
    .features i {
      width: 5px; height: 5px; border-radius: 50%;
      background: linear-gradient(135deg, #9a86ff, #3cd2f7);
    }
  </style>`;
}

// Шапка стоит на белом фоне страницы — делаем её светлой, без рамки
const headerHtml = `
  <div class="art">
    <img class="logo" src="${logoUri}">
    <div class="name">Skvoz</div>
  </div>
  <style>
    .art {
      width: 150px; height: 57px; background: #ffffff;
      display: flex; align-items: center; justify-content: flex-end; gap: 8px;
      padding-right: 10px; box-sizing: border-box;
    }
    .logo { width: 34px; height: 34px; }
    .name {
      font: 700 19px/1 ${FONT}; letter-spacing: -0.02em;
      background: linear-gradient(90deg, #6f5cff, #1fb6e0);
      -webkit-background-clip: text; color: transparent;
    }
  </style>`;

const TARGETS = [
  { file: 'installerSidebar.bmp', width: 164, height: 314, html: sidebarHtml('Пульт для zapret') },
  { file: 'uninstallerSidebar.bmp', width: 164, height: 314, html: sidebarHtml('Удаление с компьютера') },
  { file: 'installerHeader.bmp', width: 150, height: 57, html: headerHtml },
];

/** BGRA (как отдаёт NativeImage.toBitmap) → 24-битный BMP, строки снизу вверх */
function encodeBmp(bgra, width, height) {
  const rowSize = Math.ceil((width * 3) / 4) * 4;
  const dataSize = rowSize * height;
  const out = Buffer.alloc(54 + dataSize);
  out.write('BM', 0);
  out.writeUInt32LE(54 + dataSize, 2);
  out.writeUInt32LE(54, 10);
  out.writeUInt32LE(40, 14);
  out.writeInt32LE(width, 18);
  out.writeInt32LE(height, 22);
  out.writeUInt16LE(1, 26);
  out.writeUInt16LE(24, 28);
  out.writeUInt32LE(dataSize, 34);
  out.writeInt32LE(2835, 38);
  out.writeInt32LE(2835, 42);
  for (let y = 0; y < height; y += 1) {
    const rowStart = 54 + (height - 1 - y) * rowSize;
    for (let x = 0; x < width; x += 1) {
      const src = (y * width + x) * 4;
      const dst = rowStart + x * 3;
      out[dst] = bgra[src];
      out[dst + 1] = bgra[src + 1];
      out[dst + 2] = bgra[src + 2];
    }
  }
  return out;
}

async function render(target) {
  const width = target.width * SCALE;
  const height = target.height * SCALE;
  const win = new BrowserWindow({
    width,
    height,
    show: false,
    frame: false,
    useContentSize: true,
    webPreferences: { offscreen: true },
  });
  const html = `<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0;zoom:${SCALE}">${target.html}</body></html>`;
  const tmp = path.join(app.getPath('temp'), `skvoz-art-${process.pid}-${target.file}.html`);
  fs.writeFileSync(tmp, html, 'utf8');
  await win.loadFile(tmp);
  await win.webContents.executeJavaScript('document.fonts.ready.then(() => true)');
  await new Promise((resolve) => setTimeout(resolve, 300));
  const image = await win.webContents.capturePage({ x: 0, y: 0, width, height });
  win.destroy();
  fs.rmSync(tmp, { force: true });
  const scaled = image.resize({ width: target.width, height: target.height, quality: 'best' });
  const size = scaled.getSize();
  fs.writeFileSync(path.join(outDir, target.file), encodeBmp(scaled.toBitmap(), size.width, size.height));
  console.log(`Rendered assets/${target.file} (${size.width}×${size.height})`);
}

// По умолчанию Electron выходит, когда закрыто последнее окно, — а окно у нас на каждую картинку
app.on('window-all-closed', () => undefined);

app.whenReady().then(async () => {
  try {
    for (const target of TARGETS) await render(target);
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
  app.quit();
});
