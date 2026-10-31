const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');

// node scripts/clean.js dist — удалить только перечисленное
const defaultPaths = [
  'dist',
  'release',
  'out',
  path.join('assets', 'icon.ico'),
];

const removePaths = process.argv.length > 2 ? process.argv.slice(2) : defaultPaths;

for (const rel of removePaths) {
  const target = path.join(root, rel);
  try {
    fs.rmSync(target, { recursive: true, force: true });
    console.log(`Removed: ${rel}`);
  } catch (error) {
    console.warn(`Skip ${rel}: ${error instanceof Error ? error.message : error}`);
  }
}
