import { spawn } from 'child_process';

const PROBE_URLS = [
  'https://www.google.com/generate_204',
  'https://cloudflare.com/cdn-cgi/trace',
];

export async function probeBypassReachability(timeoutMs = 4_500): Promise<boolean> {
  for (const url of PROBE_URLS) {
    const ok = await curlOk(url, timeoutMs);
    if (ok) return true;
  }
  return false;
}

function curlOk(url: string, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(
      'curl.exe',
      ['-I', '-s', '--ssl-no-revoke', '-m', String(Math.max(2, Math.ceil(timeoutMs / 1000))), '-o', 'NUL', '-w', '%{http_code}', url],
      { windowsHide: true, shell: false }
    );

    let stdout = '';
    const timer = setTimeout(() => {
      child.kill();
      resolve(false);
    }, timeoutMs + 500);

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.on('error', () => {
      clearTimeout(timer);
      resolve(false);
    });
    child.on('close', () => {
      clearTimeout(timer);
      resolve(/^[23]\d\d$/.test(stdout.trim()));
    });
  });
}
