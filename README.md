# Skvoz

Пульт для Windows: [zapret-discord-youtube](https://github.com/Flowseal/zapret-discord-youtube), локальный Telegram-прокси и VPN на AmneziaWG в одном окне.

![Windows](https://img.shields.io/badge/Windows-10%2F11-blue) ![Release](https://img.shields.io/github/v/release/tw1xtyq/skvoz) ![Downloads](https://img.shields.io/github/downloads/tw1xtyq/skvoz/total) ![License](https://img.shields.io/badge/license-MIT-green)

Сайт: **[tw1xtyq.github.io](https://tw1xtyq.github.io)**

## Скачать

- [**Skvoz-Setup-1.11.5.exe**](https://github.com/tw1xtyq/skvoz/releases/download/v1.11.5/Skvoz-Setup-1.11.5.exe) — установщик (рекомендуется)
- [**Skvoz-1.11.5-Portable.exe**](https://github.com/tw1xtyq/skvoz/releases/download/v1.11.5/Skvoz-1.11.5-Portable.exe) — без установки

Нужны Windows 10/11 x64 и права администратора. Все версии — на странице [Releases](https://github.com/tw1xtyq/skvoz/releases).

> SmartScreen может предупредить о неподписанной сборке: нажмите «Подробнее → Выполнить в любом случае». Скачивайте только отсюда.

## Как пользоваться

1. Запустите Skvoz и подтвердите запрос UAC.
2. Zapret поставится сам при первом запуске. Если этого не произошло, нажмите **«Установить zapret»** на Главной.
3. На странице **Обход** нажмите **«Подобрать автоматически»**.
4. Нажмите **«Включить»** на Главной.

Telegram-прокси и VPN включаются так же: на своих страницах, на Главной или в трее.

## Обход

Skvoz раз в 30 секунд проверяет YouTube и Discord или ваши сайты. Если winws упал или сайты не открываются, он перезапускает обход, а затем переключается на другой конфиг. Для каждой сети запоминается свой рабочий конфиг.

Всё это настраивается в **Настройки → Автоматика**, а история событий видна на странице **Обход**.

## Telegram-прокси

На странице **Telegram** нажмите **«Подключить Telegram»**: прокси включится, а Telegram предложит его добавить. Дальше его достаточно включать.

Файлы из некоторых каналов идут через CDN Telegram, и не для всех его серверов есть маршрут. Такие файлы могут не загружаться, даже когда сообщения работают.

## VPN

Нажмите **«Создать VPN»**: Skvoz зарегистрирует бесплатный Cloudflare WARP и подберёт рабочий сервер за 10–30 секунд. Свой конфиг AmneziaWG или WireGuard добавляется на странице **VPN**.

Если конфиг не создаётся, на странице VPN есть подсказка, как сделать его в облаке. Регистрация WARP неофициальная, и Cloudflare может её ограничить.

Пока VPN включён, весь трафик идёт через него. Если сервер перестал отвечать, интернета не будет, пока вы не выключите VPN.

## Обновления

Skvoz и zapret проверяют обновления раз в 6 часов, настройки — в **Настройки → Обновления**. Свои списки и выбранный конфиг при обновлении сохраняются.

Если обновление не установилось, скачайте новую версию вручную по ссылкам выше.

## Если что-то не работает

- **Помощь → Диагностика** проверяет службы Windows, прокси, файлы WinDivert и конфликтующие программы.
- **Помощь → Отчёт** сохраняет файл для баг-репорта. Имя пользователя и домашняя папка в нём скрыты.
- **Помощь → Удаление** снимает службы zapret и WinDivert или удаляет zapret полностью.

Если антивирус удаляет файлы zapret, добавьте `C:\ProgramData\Skvoz` в исключения.

## Где лежат файлы

| Что | Где |
|-----|-----|
| Настройки | `%APPDATA%\zapret-app\` |
| Zapret | `C:\ProgramData\Skvoz\` |
| Конфиг VPN | `C:\ProgramData\Skvoz\amneziawg\conf` |

## Сборка

```powershell
git clone https://github.com/tw1xtyq/skvoz.git
cd skvoz
npm ci
npm run vendor
npm run build
npm start
```

`npm run pack` собирает установщик и portable в `release/`.

## Лицензия и авторы

MIT, см. [LICENSE](LICENSE). Skvoz работает благодаря проектам Flowseal ([zapret-discord-youtube](https://github.com/Flowseal/zapret-discord-youtube), [tg-ws-proxy](https://github.com/Flowseal/tg-ws-proxy)), bol-van ([zapret](https://github.com/bol-van/zapret)), MALWARE ([bash-warp-generator](https://github.com/ImMALWARE/bash-warp-generator)), Amnezia VPN ([AmneziaWG](https://github.com/amnezia-vpn/amneziawg-windows-client)), ViRb3 ([wgcf](https://github.com/ViRb3/wgcf)) и WireGuard LLC ([Wintun](https://www.wintun.net/)).

Подробности и лицензии — в [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Skvoz не связан с этими проектами и с Cloudflare.
