export function compareVersions(a: string, b: string): number {
  const pa = a.replace(/^v/i, '').split('.').map((part) => parseInt(part, 10) || 0);
  const pb = b.replace(/^v/i, '').split('.').map((part) => parseInt(part, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

export function normalizeVersion(version: string): string {
  return version.replace(/^v/i, '').trim();
}
