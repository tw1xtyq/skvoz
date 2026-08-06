const fs = require('fs');
const path = require('path');
const pngToIco = require('png-to-ico');

const root = path.join(__dirname, '..');
const pngPath = path.join(root, 'assets', 'icon.png');
const icoPath = path.join(root, 'assets', 'icon.ico');

async function main() {
  if (!fs.existsSync(pngPath)) {
    throw new Error(`Icon PNG not found: ${pngPath}`);
  }

  const buffer = await pngToIco(pngPath);
  fs.writeFileSync(icoPath, buffer);
  console.log(`Generated ${icoPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
