export function compareVersions(a: string, b: string): number {
  const pa = a.replace(/^v/i, '').split('.').map((part) => parseInt(part, 10) || 0);
  const pb = b.replace(/^v/i, '').split('.').map((part) => parseInt(part, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  // Буква — отдельный релиз zapret: 1.9.9 < 1.9.9a < 1.9.9d
  const letter = (version: string): string => version.match(/\d([a-z])$/i)?.[1].toLowerCase() ?? '';
  return letter(a).localeCompare(letter(b));
}

export function normalizeVersion(version: string): string {
  return version.replace(/^v/i, '').trim();
}
