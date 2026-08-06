import { app, nativeImage, type NativeImage } from 'electron';
import fs from 'fs';
import path from 'path';

const iconCache = new Map<number, NativeImage>();

function resolveAsset(fileName: string): string {
  const candidates = [
    path.join(app.getAppPath(), 'assets', fileName),
    path.join(__dirname, '..', '..', 'assets', fileName),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }

  return candidates[0];
}

export function loadAppIcon(size?: number): NativeImage {
  if (size && iconCache.has(size)) {
    return iconCache.get(size)!;
  }

  const iconPath = resolveAsset('icon.png');
  let image = nativeImage.createFromPath(iconPath);

  if (image.isEmpty()) {
    return nativeImage.createEmpty();
  }

  if (size) {
    image = image.resize({ width: size, height: size, quality: 'good' });
    iconCache.set(size, image);
  }

  return image;
}
