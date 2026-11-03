# Сторонние проекты в Skvoz

Skvoz построен на работе других авторов. Ниже перечислено, чей код, программы и данные используются, как именно и под какой лицензией. Полные тексты лицензий лежат в папке [`licenses/`](licenses/), а в установленном приложении — в `resources\licenses`.

Skvoz не связан ни с одним из перечисленных проектов и компаний и не одобрен ими. Все названия и товарные знаки принадлежат их владельцам.

## Что встроено в Skvoz

| Проект | Автор | Как используется | Лицензия |
|--------|-------|------------------|----------|
| [amneziawg-windows-client](https://github.com/amnezia-vpn/amneziawg-windows-client) | Amnezia VPN, на основе wireguard-windows (WireGuard LLC) | `amneziawg.exe` из официального MSI-пакета без изменений: поднимает туннель VPN как службу Windows | MIT — [licenses/amneziawg-windows-client.txt](licenses/amneziawg-windows-client.txt) |
| [amneziawg-tools](https://github.com/amnezia-vpn/amneziawg-tools) | Amnezia VPN, на основе wireguard-tools (Jason A. Donenfeld) | `awg.exe` из того же MSI без изменений: показывает трафик и время ответа сервера | GPL-2.0 — [licenses/amneziawg-tools-GPL-2.0.txt](licenses/amneziawg-tools-GPL-2.0.txt). Исходный код: [github.com/amnezia-vpn/amneziawg-tools](https://github.com/amnezia-vpn/amneziawg-tools) |
| [Wintun](https://www.wintun.net/) | WireGuard LLC | `wintun.dll` из того же MSI без изменений: виртуальный сетевой адаптер, используется только через его API | Prebuilt Binaries License — [licenses/wintun-prebuilt-binaries.txt](licenses/wintun-prebuilt-binaries.txt) |
| [wgcf](https://github.com/ViRb3/wgcf) | ViRb3 | `wgcf.exe` без изменений: запасной способ регистрации аккаунта Cloudflare WARP. Skvoz обновляет его с GitHub, сверяя SHA-256 | MIT — [licenses/wgcf.txt](licenses/wgcf.txt) |
| [Inter](https://github.com/rsms/inter) | The Inter Project Authors | Шрифт интерфейса | SIL OFL 1.1 — [licenses/inter-OFL.txt](licenses/inter-OFL.txt) |
| [JetBrains Mono](https://github.com/JetBrains/JetBrainsMono) | The JetBrains Mono Project Authors | Моноширинный шрифт журнала и полей | SIL OFL 1.1 — [licenses/jetbrains-mono-OFL.txt](licenses/jetbrains-mono-OFL.txt) |
| [Electron](https://www.electronjs.org/) | OpenJS Foundation и участники | Основа приложения | MIT; лицензии Electron и Chromium electron-builder кладёт рядом с программой (`LICENSE.electron.txt`, `LICENSES.chromium.html`) |

## Код и идеи, перенесённые в Skvoz

| Проект | Автор | Что взято | Лицензия |
|--------|-------|-----------|----------|
| [tg-ws-proxy](https://github.com/Flowseal/tg-ws-proxy) | Flowseal | Локальный Telegram-прокси (MTProto → WebSocket) портирован на TypeScript: `src/main/tgws/`. Список доменов Cloudflare для прокси загружается из этого репозитория | MIT — [licenses/tg-ws-proxy.txt](licenses/tg-ws-proxy.txt) |
| [bash-warp-generator](https://github.com/ImMALWARE/bash-warp-generator) | MALWARE ([гайд по WARP](https://wiki.malw.link/network/vpns/warp)) | Способ регистрации WARP и параметры маскировки AmneziaWG: Jc/Jmin/Jmax, S1/S2, H1–H4, пакет-приманка `I1`, рекомендуемый сервер. Skvoz периодически читает актуальные значения из `warp_generator.sh` как данные (код не выполняется) | MIT — [licenses/bash-warp-generator.txt](licenses/bash-warp-generator.txt) |

## Что Skvoz скачивает по вашей команде

| Проект | Автор | Как используется | Лицензия |
|--------|-------|------------------|----------|
| [zapret-discord-youtube](https://github.com/Flowseal/zapret-discord-youtube) | Flowseal, на основе [zapret](https://github.com/bol-van/zapret) от bol-van | Скачивается с GitHub по кнопке «Скачать с GitHub» и обновляется. Skvoz запускает его `.bat` и `winws.exe` и не изменяет их | MIT — [licenses/zapret-discord-youtube.txt](licenses/zapret-discord-youtube.txt) |

## Сервисы

- **Cloudflare WARP** — бесплатный VPN-сервис Cloudflare, Inc. Генератор регистрирует на нём устройство тем же способом, что bash-warp-generator и wgcf. Это неофициальный способ: Cloudflare может изменить или ограничить его в любой момент. Пользуясь им, вы принимаете [условия Cloudflare](https://www.cloudflare.com/application/terms/).
- **GitHub** — источник обновлений Skvoz, zapret, wgcf и параметров маскировки.

## Как компоненты попадают в сборку

`npm run vendor` ([scripts/fetch-vendor.js](scripts/fetch-vendor.js)) берёт последние релизы AmneziaWG и wgcf с GitHub и сверяет SHA-256, который публикует GitHub. Если GitHub недоступен, скрипт использует закреплённые версии с известными контрольными суммами. Файлы ничем не изменяются.
