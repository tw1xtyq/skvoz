import { spawn } from 'child_process';
import os from 'os';
import { decodeProcessOutput } from './exec';

export interface NetworkIdentity {
  /** MAC роутера — у каждой сети свой, в отличие от IP шлюза вроде 192.168.1.1 */
  id: string;
  label: string;
}

export const UNKNOWN_NETWORK: NetworkIdentity = { id: 'unknown', label: 'Неизвестная сеть' };

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

/** Шлюз маршрута 0.0.0.0/0 с наименьшей метрикой из `route print -4 0.0.0.0` */
export function parseDefaultGateway(routePrint: string): string | null {
  let best: { gateway: string; metric: number } | null = null;
  for (const line of routePrint.split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 5 || parts[0] !== '0.0.0.0' || parts[1] !== '0.0.0.0') continue;
    const [, , gateway, , metricRaw] = parts;
    const metric = Number(metricRaw);
    if (!IPV4.test(gateway) || gateway === '0.0.0.0' || !Number.isFinite(metric)) continue;
    if (!best || metric < best.metric) best = { gateway, metric };
  }
  return best?.gateway ?? null;
}

export function parseArpMac(arpOutput: string, ip: string): string | null {
  const escaped = ip.replace(/\./g, '\\.');
  const match = arpOutput.match(new RegExp(`^\\s*${escaped}\\s+([0-9a-f]{2}(?:-[0-9a-f]{2}){5})`, 'im'));
  const mac = match?.[1].toLowerCase();
  // ff-ff-… и 00-00-… бывают у широковещательных и неразрешённых записей
  if (!mac || mac === 'ff-ff-ff-ff-ff-ff' || mac === '00-00-00-00-00-00') return null;
  return mac;
}

/** SSID из `netsh wlan show interfaces`; строку BSSID пропускаем */
export function parseWlanSsid(netshOutput: string): string | null {
  const match = netshOutput.match(/^\s*SSID\s*:\s*(.+?)\s*$/m);
  return match?.[1] || null;
}

/** Дешёвый отпечаток адресов: меняется при переключении сети, без запуска внешних команд */
export function interfacesFingerprint(ifaces: NodeJS.Dict<os.NetworkInterfaceInfo[]> = os.networkInterfaces()): string {
  const parts: string[] = [];
  for (const [name, infos] of Object.entries(ifaces)) {
    for (const info of infos ?? []) {
      if (info.internal || info.family !== 'IPv4') continue;
      parts.push(`${name}=${info.address}/${info.netmask}`);
    }
  }
  return parts.sort().join(';');
}

export async function detectNetwork(): Promise<NetworkIdentity> {
  const route = await capture('route', ['print', '-4', '0.0.0.0']);
  const gateway = route ? parseDefaultGateway(route) : null;
  if (!gateway) return UNKNOWN_NETWORK;

  const [arp, wlan] = await Promise.all([capture('arp', ['-a', gateway]), capture('netsh', ['wlan', 'show', 'interfaces'])]);
  const mac = arp ? parseArpMac(arp, gateway) : null;
  const ssid = wlan ? parseWlanSsid(wlan) : null;
  return {
    id: mac ? `mac:${mac}` : `gw:${gateway}`,
    label: ssid ?? `Сеть ${gateway}`,
  };
}

export function capture(command: string, args: string[], timeoutMs = 5_000): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { windowsHide: true, shell: false });
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => {
      child.kill();
      resolve(null);
    }, timeoutMs);
    child.stdout?.on('data', (chunk: Buffer) => chunks.push(chunk));
    child.on('error', () => {
      clearTimeout(timer);
      resolve(null);
    });
    child.on('close', () => {
      clearTimeout(timer);
      resolve(decodeProcessOutput(Buffer.concat(chunks)));
    });
  });
}
