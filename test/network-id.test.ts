import { test } from 'node:test';
import assert from 'node:assert/strict';
import { interfacesFingerprint, parseArpMac, parseDefaultGateway, parseWlanSsid } from '../src/main/network-id';

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
