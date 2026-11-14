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

export interface RouteLine {
  destination: string;
  mask: string;
  gateway: string;
  /** IP интерфейса, через который идёт маршрут */
  iface: string;
  metric: number;
}

/** Строки активных маршрутов из `route print -4` */
export function parseRoutes(routePrint: string): RouteLine[] {
  const routes: RouteLine[] = [];
  for (const line of routePrint.split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 5) continue;
    const [destination, mask, gateway, iface, metricRaw] = parts;
    const metric = Number(metricRaw);
    if (!IPV4.test(destination) || !IPV4.test(mask) || !IPV4.test(iface) || !Number.isFinite(metric)) continue;
    routes.push({ destination, mask, gateway, iface, metric });
  }
  return routes;
}

/**
 * Адаптеры VPN-клиентов: AmneziaVPN, Hiddify, v2rayN, NekoBox, Outline, WARP, WireGuard,
 * Tailscale и т. п. Их шлюз — не новая сеть, а туннель поверх той же.
 */
const TUNNEL_ADAPTER = /^(tun|tap|utun|wg)\d*$|wintun|wireguard|amnezia|sing-?tun|outline|warp|clash|mihomo|nekoray|nekobox|hiddify|v2ray|xray|happ|throne|karing|zerotier|tailscale|radmin|hamachi|openvpn|proton|nord|vpn/i;

export function isTunnelAdapter(name: string): boolean {
  return TUNNEL_ADAPTER.test(name.trim());
}

/** IPv4-адрес → имя адаптера, только для туннелей */
export function tunnelAddresses(ifaces: NodeJS.Dict<os.NetworkInterfaceInfo[]> = os.networkInterfaces()): Map<string, string> {
  const result = new Map<string, string>();
  for (const [name, infos] of Object.entries(ifaces)) {
    if (!isTunnelAdapter(name)) continue;
    for (const info of infos ?? []) {
      if (!info.internal && info.family === 'IPv4') result.set(info.address, name);
    }
  }
  return result;
}

/** Маршруты, которыми VPN забирает весь интернет: 0.0.0.0/0 или пара 0.0.0.0/1 + 128.0.0.0/1 */
function isCatchAllRoute(route: RouteLine): boolean {
  if (route.destination === '0.0.0.0' && (route.mask === '0.0.0.0' || route.mask === '128.0.0.0')) return true;
  return route.destination === '128.0.0.0' && route.mask === '128.0.0.0';
}

/**
 * Сторонний VPN, через который сейчас идёт весь интернет. Свой туннель Skvoz (ownTunnels)
 * не в счёт: про него приложение и так знает.
 */
export function findForeignTunnel(
  routePrint: string,
  tunnels: Map<string, string>,
  ownTunnels: readonly string[] = []
): string | null {
  const own = new Set(ownTunnels.map((name) => name.toLowerCase()));
  for (const route of parseRoutes(routePrint)) {
    if (!isCatchAllRoute(route)) continue;
    const name = tunnels.get(route.iface);
    if (name && !own.has(name.toLowerCase())) return name;
  }
  return null;
}

/** Шлюз маршрута 0.0.0.0/0 с наименьшей метрикой; маршруты через туннели VPN не считаются сетью */
export function parseDefaultGateway(routePrint: string, tunnelIfaces: ReadonlySet<string> = new Set()): string | null {
  let best: { gateway: string; metric: number } | null = null;
  for (const route of parseRoutes(routePrint)) {
    if (route.destination !== '0.0.0.0' || route.mask !== '0.0.0.0') continue;
    if (tunnelIfaces.has(route.iface)) continue;
    if (route.gateway === '0.0.0.0' || !IPV4.test(route.gateway)) continue;
    if (!best || route.metric < best.metric) best = { gateway: route.gateway, metric: route.metric };
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

/**
 * Дешёвый отпечаток адресов: меняется при переключении сети, без запуска внешних команд.
 * Туннели VPN по умолчанию не учитываются: включение VPN — не смена сети.
 */
export function interfacesFingerprint(
  ifaces: NodeJS.Dict<os.NetworkInterfaceInfo[]> = os.networkInterfaces(),
  options: { tunnels?: 'skip' | 'only' } = {}
): string {
  const mode = options.tunnels ?? 'skip';
  const parts: string[] = [];
  for (const [name, infos] of Object.entries(ifaces)) {
    if (isTunnelAdapter(name) !== (mode === 'only')) continue;
    for (const info of infos ?? []) {
      if (info.internal || info.family !== 'IPv4') continue;
      parts.push(`${name}=${info.address}/${info.netmask}`);
    }
  }
  return parts.sort().join(';');
}

/** Через какой сторонний VPN сейчас идёт весь интернет, или null */
export async function detectForeignTunnel(ownTunnels: readonly string[] = []): Promise<string | null> {
  const tunnels = tunnelAddresses();
  if (tunnels.size === 0) return null;
  const route = await capture('route', ['print', '-4']);
  return route ? findForeignTunnel(route, tunnels, ownTunnels) : null;
}

export async function detectNetwork(): Promise<NetworkIdentity> {
  const route = await capture('route', ['print', '-4', '0.0.0.0']);
  const gateway = route ? parseDefaultGateway(route, new Set(tunnelAddresses().keys())) : null;
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
