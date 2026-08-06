const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');

const removePaths = [
  'dist',
  'release',
  'out',
  path.join('assets', 'icon.ico'),
];

for (const rel of removePaths) {
  const target = path.join(root, rel);
  try {
    fs.rmSync(target, { recursive: true, force: true });
    console.log(`Removed: ${rel}`);
  } catch (error) {
    console.warn(`Skip ${rel}: ${error instanceof Error ? error.message : error}`);
  }
}
