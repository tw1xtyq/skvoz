import crypto from 'crypto';

/** Последний релиз стороннего компонента на GitHub с проверяемым файлом. */
export interface GithubAsset {
  version: string;
  name: string;
  url: string;
  sha256: string;
  releasePage: string;
}

const HEADERS = { 'User-Agent': 'zapret-app', Accept: 'application/vnd.github+json' };

export async function fetchLatestAsset(repo: string, assetPattern: RegExp, timeoutMs = 8_000): Promise<GithubAsset> {
  const response = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
    headers: HEADERS,
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`GitHub ${repo}: HTTP ${response.status}`);
  const data = (await response.json()) as {
    tag_name: string;
    html_url: string;
    assets: Array<{ name: string; browser_download_url: string; digest?: string | null }>;
  };
  const asset = data.assets.find((item) => assetPattern.test(item.name));
  if (!asset) throw new Error(`В релизе ${repo} нет подходящего файла`);
  // GitHub сам считает SHA-256 каждого файла релиза — без него не скачиваем
  const sha256 = asset.digest?.match(/^sha256:([0-9a-f]{64})$/i)?.[1];
  if (!sha256) throw new Error(`GitHub не прислал контрольную сумму ${asset.name}`);
  return {
    version: data.tag_name.replace(/^v/i, ''),
    name: asset.name,
    url: asset.browser_download_url,
    sha256: sha256.toLowerCase(),
    releasePage: data.html_url,
  };
}

export async function downloadVerified(asset: GithubAsset, timeoutMs = 120_000): Promise<Buffer> {
  const response = await fetch(asset.url, {
    headers: { 'User-Agent': 'zapret-app' },
    redirect: 'follow',
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`Загрузка ${asset.name}: HTTP ${response.status}`);
  const data = Buffer.from(await response.arrayBuffer());
  const hash = crypto.createHash('sha256').update(data).digest('hex');
  if (hash !== asset.sha256) throw new Error(`Контрольная сумма ${asset.name} не совпала — файл отброшен`);
  return data;
}
