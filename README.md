# Zapret App

Графический пульт для [zapret-discord-youtube](https://github.com/Flowseal/zapret-discord-youtube) на Windows: скачать zapret, выбрать стратегию, запустить обход, добавить свои домены и IP.

![Windows](https://img.shields.io/badge/Windows-10%2F11-blue) ![License](https://img.shields.io/badge/license-MIT-green)

## Скачать

[**Releases → последняя версия**](https://github.com/ProtheticGlitch/zapret-app/releases/latest)

| Файл | Описание |
|------|----------|
| `Zapret-App-Setup-*.exe` | Установщик |
| `Zapret-App-*-Portable.exe` | Portable, без установки |

## Как пользоваться

1. Скачайте и запустите exe (или установите через Setup).
2. Подтвердите **UAC** — права администратора обязательны.
3. Если zapret ещё не установлен — нажмите **«Скачать с GitHub»**.
4. Выберите стратегию и нажмите **кнопку питания** (старт обхода).

Portable и установленная версия хранят настройки в `%APPDATA%\zapret-app\`.

> Windows может показать SmartScreen — сборки без платной подписи. Скачивайте только из Releases этого репозитория.

## Требования

- Windows 10/11 (64-bit)
- Права администратора
- Интернет для первой установки zapret

## Свои домены и IP

В настройках приложения:

| Список | Файл |
|--------|------|
| Для обхода | `list-general-user.txt` |
| Исключить домены | `list-exclude-user.txt` |
| Исключить IP | `ipset-exclude-user.txt` |

После изменений: **Стоп → Старт**.

## Автозапуск и автоподбор

- **Автозапуск приложения** — открывает Zapret App при входе в Windows (через планировщик задач).
- **Автозапуск обхода** — выключен по умолчанию; при включении запускает zapret при старте приложения (и включает автозапуск приложения).
- **Автоподбор конфига** — проверяет все `.bat` и выбирает лучший при первом запуске.

## Сборка из исходников

```powershell
git clone https://github.com/ProtheticGlitch/zapret-app.git
cd zapret-app
npm ci
npm run build
npm start
```

## Лицензия

MIT — см. [LICENSE](LICENSE).

Основа обхода: [Flowseal/zapret-discord-youtube](https://github.com/Flowseal/zapret-discord-youtube).
