// Готовит сторонние компоненты, которые едут внутри Skvoz (vendor/ → resources/):
//  - AmneziaWG: amneziawg.exe, awg.exe и wintun.dll из официального MSI, без установки;
//  - wgcf: запасной способ регистрации Cloudflare WARP.
// Берёт последние релизы и сверяет SHA-256, который публикует GitHub. Если GitHub недоступен,
// использует закреплённые версии. SKVOZ_VENDOR_PINNED=1 — всегда закреплённые.
const { spawnSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const VENDOR_DIR = path.join(__dirname, '..', 'vendor');
const PINNED_ONLY = process.env.SKVOZ_VENDOR_PINNED === '1';

const COMPONENTS = {
  amneziawg: {
    repo: 'amnezia-vpn/amneziawg-windows-client',
    asset: /^amneziawg-amd64-[\d.]+\.msi$/,
    files: ['amneziawg.exe', 'awg.exe', 'wintun.dll'],
    pinned: {
      version: '3.1.0',
      url: 'https://github.com/amnezia-vpn/amneziawg-windows-client/releases/download/3.1.0/amneziawg-amd64-3.1.0.msi',
      sha256: 'a1b48ea8699cd347832a3691d832004574ef8ad65bcf887611ac8acb99b7de8b',
    },
  },
  wgcf: {
    repo: 'ViRb3/wgcf',
    asset: /^wgcf_[\d.]+_windows_amd64\.exe$/,
    files: ['wgcf.exe'],
    pinned: {
      version: '2.3.1',
      url: 'https://github.com/ViRb3/wgcf/releases/download/v2.3.1/wgcf_2.3.1_windows_amd64.exe',
      sha256: 'e222fd9443d7cb3264d825a3e86967797fc9c938507c5d93e3cc21e4aed11dcc',
    },
  },
};

function githubHeaders() {
  const headers = { 'User-Agent': 'zapret-app', Accept: 'application/vnd.github+json' };
  // В CI у анонимных запросов лимит 60 в час — токен снимает его
  if (process.env.SKVOZ_GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.SKVOZ_GITHUB_TOKEN}`;
  return headers;
}

async function resolveRelease(component) {
  if (PINNED_ONLY) return { ...component.pinned, source: 'закреплённая' };
  try {
    const response = await fetch(`https://api.github.com/repos/${component.repo}/releases/latest`, {
      headers: githubHeaders(),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    const asset = data.assets.find((item) => component.asset.test(item.name));
    const sha256 = asset?.digest?.match(/^sha256:([0-9a-f]{64})$/i)?.[1];
    if (!asset || !sha256) throw new Error('нет файла или контрольной суммы');
    return { version: data.tag_name.replace(/^v/i, ''), url: asset.browser_download_url, sha256: sha256.toLowerCase(), source: 'последняя' };
  } catch (error) {
    console.warn(`${component.repo}: не удалось узнать последний релиз (${error.message}), берём закреплённый`);
    return { ...component.pinned, source: 'закреплённая' };
  }
}

function installedVersion(dir, files) {
  const versionFile = path.join(dir, 'VERSION');
  if (!fs.existsSync(versionFile)) return null;
  if (!files.every((name) => fs.existsSync(path.join(dir, name)))) return null;
  return fs.readFileSync(versionFile, 'utf8').trim();
}

async function download(release) {
  console.log(`Загрузка ${release.url}`);
  const response = await fetch(release.url, { headers: { 'User-Agent': 'zapret-app' }, redirect: 'follow' });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const data = Buffer.from(await response.arrayBuffer());
  const hash = crypto.createHash('sha256').update(data).digest('hex');
  if (hash !== release.sha256) throw new Error(`Неверная контрольная сумма ${path.basename(release.url)}: ${hash}`);
  return data;
}

function extractMsi(msiData, files, targetDir) {
  if (process.platform !== 'win32') throw new Error('Распаковка MSI возможна только на Windows');
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skvoz-awg-'));
  try {
    const msiPath = path.join(tempDir, 'amneziawg.msi');
    const extractDir = path.join(tempDir, 'x');
    fs.writeFileSync(msiPath, msiData);
    // Административная установка только распаковывает файлы, в систему ничего не ставится.
    // msiexec ждёт кавычки вокруг значения свойства, поэтому аргументы собираем сами
    const result = spawnSync('msiexec.exe', ['/a', `"${msiPath}"`, '/qn', `TARGETDIR="${extractDir}"`], {
      windowsHide: true,
      windowsVerbatimArguments: true,
    });
    if (result.status !== 0) throw new Error(`msiexec завершился с кодом ${result.status}`);
    for (const name of files) {
      const from = path.join(extractDir, 'AmneziaWG', name);
      if (!fs.existsSync(from)) throw new Error(`В MSI нет ${name}`);
      fs.copyFileSync(from, path.join(targetDir, name));
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function prepare(name, component) {
  const dir = path.join(VENDOR_DIR, name);
  const release = await resolveRelease(component);
  if (installedVersion(dir, component.files) === release.version) {
    console.log(`${name} ${release.version} уже в vendor/${name}`);
    return;
  }
  const data = await download(release);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  if (name === 'amneziawg') extractMsi(data, component.files, dir);
  else fs.writeFileSync(path.join(dir, component.files[0]), data);
  fs.writeFileSync(path.join(dir, 'VERSION'), `${release.version}\n`);
  console.log(`${name} ${release.version} (${release.source} версия) готов в vendor/${name}`);
}

async function main() {
  for (const [name, component] of Object.entries(COMPONENTS)) await prepare(name, component);
}

main().catch((error) => {
  console.error(`fetch-vendor: ${error.message}`);
  process.exit(1);
});
