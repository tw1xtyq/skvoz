const fs = require('fs');
const path = require('path');

const srcDir = path.join(__dirname, '..', 'src', 'renderer');
const destDir = path.join(__dirname, '..', 'dist', 'renderer');
const rootAssetsDir = path.join(__dirname, '..', 'assets');
const distAssetsDir = path.join(__dirname, '..', 'dist', 'assets');

function copyDir(source, target) {
  fs.mkdirSync(target, { recursive: true });

  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name);
    const to = path.join(target, entry.name);

    if (entry.isDirectory()) {
      copyDir(from, to);
      continue;
    }

    fs.copyFileSync(from, to);
  }
}

fs.mkdirSync(destDir, { recursive: true });

for (const file of ['index.html', 'tray.html', 'styles.css']) {
  fs.copyFileSync(path.join(srcDir, file), path.join(destDir, file));
}

const rendererAssets = path.join(srcDir, 'assets');
if (fs.existsSync(rendererAssets)) {
  copyDir(rendererAssets, path.join(destDir, 'assets'));
}

if (fs.existsSync(rootAssetsDir)) {
  copyDir(rootAssetsDir, distAssetsDir);
}
