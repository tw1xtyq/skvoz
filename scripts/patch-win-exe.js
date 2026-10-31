/** @param {import('app-builder-lib').AfterPackContext} context */
exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'win32') return;

  const rcedit = require('rcedit');
  const path = require('path');

  const exe = path.join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.exe`
  );
  const icon = path.join(__dirname, '..', 'assets', 'icon.ico');
  const manifest = path.join(__dirname, '..', 'assets', 'app.manifest');

  const pkg = require('../package.json');
  const version = String(pkg.version || '1.0.0');
  const versionQuad = `${version.split('.').concat(['0', '0', '0']).slice(0, 4).join('.')}`;
  const productName = context.packager.appInfo.productName || 'Skvoz';

  await rcedit(exe, {
    icon,
    'requested-execution-level': 'requireAdministrator',
    'application-manifest': manifest,
    'file-version': versionQuad,
    'product-version': versionQuad,
    'version-string': {
      FileDescription: productName,
      ProductName: productName,
      OriginalFilename: `${productName}.exe`,
      InternalName: productName,
      CompanyName: pkg.author || 'ProtheticGlitch',
      LegalCopyright: pkg.build?.copyright || `Copyright © ${new Date().getFullYear()} ProtheticGlitch`,
    },
  });

  console.log(`Patched Windows executable: ${exe}`);
};
