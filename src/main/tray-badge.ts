import { nativeImage, type NativeImage } from 'electron';

export type Rgb = [number, number, number];

/**
 * Рисует цветную точку с тёмной обводкой в правом нижнем углу.
 * bitmap — BGRA с предумноженной альфой, как его отдаёт NativeImage.toBitmap() в Windows.
 */
export function paintStatusDot(bitmap: Buffer, width: number, height: number, rgb: Rgb): Buffer {
  const out = Buffer.from(bitmap);
  const radius = Math.max(2, Math.round(Math.min(width, height) * 0.2));
  const outline = Math.max(1, radius * 0.45);
  const cx = width - radius - outline;
  const cy = height - radius - outline;
  const [r, g, b] = rgb;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
      const ring = clamp01(radius + outline + 0.5 - d);
      if (ring <= 0) continue;
      const fill = clamp01(radius + 0.5 - d);
      // обводка почти чёрная, чтобы точку было видно и на светлой, и на тёмной панели задач
      const sr = r * fill + 20 * (1 - fill);
      const sg = g * fill + 20 * (1 - fill);
      const sb = b * fill + 20 * (1 - fill);
      const i = (y * width + x) * 4;
      const a = ring;
      out[i] = Math.round(sb * a + out[i] * (1 - a));
      out[i + 1] = Math.round(sg * a + out[i + 1] * (1 - a));
      out[i + 2] = Math.round(sr * a + out[i + 2] * (1 - a));
      out[i + 3] = Math.round(255 * a + out[i + 3] * (1 - a));
    }
  }
  return out;
}

export function withStatusDot(base: NativeImage, rgb: Rgb): NativeImage {
  const { width, height } = base.getSize();
  if (!width || !height) return base;
  const painted = paintStatusDot(base.toBitmap(), width, height, rgb);
  return nativeImage.createFromBitmap(painted, { width, height });
}

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}
