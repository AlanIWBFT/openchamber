const fs = require('node:fs');
const path = require('node:path');

module.exports = async (context) => {
  const resourcesPath = context.electronPlatformName === 'darwin'
    ? path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, 'Contents', 'Resources')
    : path.join(context.appOutDir, 'resources');
  if (context.electronPlatformName === 'win32') {
    const { detectExecutableArch } = await import('./ensure-electron.mjs');
    const nativePath = path.join(resourcesPath, 'native', 'openchamber_shell.node');
    const executablePath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.exe`);
    const nativeArch = detectExecutableArch(nativePath);
    if (!nativeArch || nativeArch !== detectExecutableArch(executablePath)) {
      throw new Error(`Missing or wrong-architecture Windows shell module at ${nativePath}`);
    }
    return;
  }
  if (context.electronPlatformName !== 'darwin') return;

  const sourceAssetsPath = path.join(__dirname, '..', 'resources', 'icons', 'Assets.car');

  if (!fs.existsSync(sourceAssetsPath)) {
    throw new Error(`Missing compiled app icon asset catalog at ${sourceAssetsPath}`);
  }

  fs.copyFileSync(sourceAssetsPath, path.join(resourcesPath, 'Assets.car'));
};
