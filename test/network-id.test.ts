import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  findForeignTunnel,
  interfacesFingerprint,
  isTunnelAdapter,
  parseArpMac,
  parseDefaultGateway,
  parseWlanSsid,
  tunnelAddresses,
} from '../src/main/network-id';

const ROUTE_PRINT = `
===========================================================================
Список интерфейсов
 12...aa bb cc dd ee ff ......Intel(R) Wi-Fi 6 AX201 160MHz
  1...........................Software Loopback Interface 1
===========================================================================

IPv4 таблица маршрута
===========================================================================
Активные маршруты:
Сетевой адрес           Маска сети      Адрес шлюза       Интерфейс  Метрика
          0.0.0.0          0.0.0.0     192.168.0.1     192.168.0.42     50
          0.0.0.0          0.0.0.0      10.0.0.1         10.0.0.7     25
        127.0.0.0        255.0.0.0         On-link         127.0.0.1    331
===========================================================================
Постоянные маршруты:
  Отсутствует
`;

test('шлюз по умолчанию — с наименьшей метрикой', () => {
  assert.equal(parseDefaultGateway(ROUTE_PRINT), '10.0.0.1');
});

test('шлюз 0.0.0.0 у туннеля — не шлюз', () => {
  assert.equal(parseDefaultGateway('          0.0.0.0          0.0.0.0          0.0.0.0        10.8.0.2      5'), null);
});

test('без маршрута по умолчанию шлюза нет', () => {
  assert.equal(parseDefaultGateway('        127.0.0.0        255.0.0.0         On-link         127.0.0.1    331'), null);
});

test('MAC роутера из arp', () => {
  const arp = `
Интерфейс: 10.0.0.7 --- 0xc
  адрес в Интернете      Физический адрес      Тип
  10.0.0.1              A4-2B-B0-11-22-33     динамический
  10.0.0.255            ff-ff-ff-ff-ff-ff     статический
`;
  assert.equal(parseArpMac(arp, '10.0.0.1'), 'a4-2b-b0-11-22-33');
  assert.equal(parseArpMac(arp, '10.0.0.255'), null, 'широковещательный адрес не годится');
  assert.equal(parseArpMac(arp, '10.0.0.10'), null);
});

test('IP шлюза не путается с похожим длиннее', () => {
  const arp = '  10.0.0.12             a4-2b-b0-11-22-33     dynamic';
  assert.equal(parseArpMac(arp, '10.0.0.1'), null);
});

test('SSID берётся из строки SSID, а не BSSID', () => {
  const netsh = `
    Имя                    : Беспроводная сеть
    Состояние              : подключено
    SSID                   : Дом 5G
    BSSID                  : a4:2b:b0:11:22:33
`;
  assert.equal(parseWlanSsid(netsh), 'Дом 5G');
  assert.equal(parseWlanSsid('Служба беспроводной автонастройки не запущена.'), null);
});

test('отпечаток адресов не зависит от порядка и пропускает loopback и IPv6', () => {
  const base = { address: '', netmask: '255.255.255.0', mac: '00:00:00:00:00:00', cidr: null };
  const a = interfacesFingerprint({
    'Wi-Fi': [
      { ...base, family: 'IPv4', address: '192.168.0.42', internal: false },
      { ...base, family: 'IPv6', address: 'fe80::1', internal: false, scopeid: 0 },
    ],
    Loopback: [{ ...base, family: 'IPv4', address: '127.0.0.1', internal: true }],
    Ethernet: [{ ...base, family: 'IPv4', address: '10.0.0.7', internal: false }],
  });
  const b = interfacesFingerprint({
    Ethernet: [{ ...base, family: 'IPv4', address: '10.0.0.7', internal: false }],
    'Wi-Fi': [{ ...base, family: 'IPv4', address: '192.168.0.42', internal: false }],
  });
  assert.equal(a, b);
  assert.ok(!a.includes('127.0.0.1'));
});

// AmneziaVPN (sing-tun): весь интернет через tun0 парой маршрутов /1
const AMNEZIA_ROUTES = `
Активные маршруты:
Сетевой адрес           Маска сети      Адрес шлюза       Интерфейс  Метрика
          0.0.0.0          0.0.0.0      192.168.0.1     192.168.0.12     25
          0.0.0.0        128.0.0.0       172.19.0.2       172.19.0.1      0
        128.0.0.0        128.0.0.0       172.19.0.2       172.19.0.1      0
          0.0.0.0          0.0.0.0       172.19.0.2       172.19.0.1      5
Постоянные маршруты:
  Сетевой адрес            Маска    Адрес шлюза      Метрика
          0.0.0.0          0.0.0.0      192.168.0.1  По умолчанию
`;

const IFACES = {
  'Беспроводная сеть': [{ address: '192.168.0.12', netmask: '255.255.255.0', family: 'IPv4', internal: false }],
  tun0: [{ address: '172.19.0.1', netmask: '255.255.255.252', family: 'IPv4', internal: false }],
  SkvozVPN: [{ address: '10.8.1.2', netmask: '255.255.255.255', family: 'IPv4', internal: false }],
} as unknown as NodeJS.Dict<import('os').NetworkInterfaceInfo[]>;

test('туннели VPN узнаются по имени адаптера', () => {
  for (const name of ['tun0', 'wg0', 'AmneziaVPN', 'sing-tun Tunnel', 'WireGuard Tunnel', 'Outline-Tap', 'CloudflareWARP', 'SkvozVPN']) {
    assert.ok(isTunnelAdapter(name), name);
  }
  for (const name of ['Ethernet', 'Беспроводная сеть', 'Wi-Fi', 'Ethernet 2']) assert.ok(!isTunnelAdapter(name), name);
});

test('шлюз чужого VPN — не новая сеть', () => {
  const tunnels = new Set(tunnelAddresses(IFACES).keys());
  assert.equal(parseDefaultGateway(AMNEZIA_ROUTES, tunnels), '192.168.0.1');
});

test('чужой VPN на весь трафик находится, свой — нет', () => {
  const tunnels = tunnelAddresses(IFACES);
  assert.equal(findForeignTunnel(AMNEZIA_ROUTES, tunnels, ['SkvozVPN']), 'tun0');
  const own = '          0.0.0.0          0.0.0.0         10.8.1.1         10.8.1.2      5';
  assert.equal(findForeignTunnel(own, tunnels, ['SkvozVPN']), null);
  // туннель есть, но интернет идёт мимо него (раздельное туннелирование)
  const split = '         10.0.0.0      255.0.0.0       172.19.0.2       172.19.0.1      5';
  assert.equal(findForeignTunnel(split, tunnels, ['SkvozVPN']), null);
});

test('включение VPN не меняет отпечаток сети', () => {
  const { tun0: _tun, SkvozVPN: _own, ...plain } = IFACES;
  assert.equal(interfacesFingerprint(IFACES), interfacesFingerprint(plain));
  assert.notEqual(interfacesFingerprint(IFACES, { tunnels: 'only' }), '');
  assert.equal(interfacesFingerprint(plain, { tunnels: 'only' }), '');
});
