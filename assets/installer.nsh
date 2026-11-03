; Оформление и поведение установщика Skvoz. electron-builder подключает этот файл
; сам — он лежит в buildResources (assets). Картинки рисует npm run installer-art.

; Без вопроса «для кого установить»: прежние версии стоят для текущего пользователя,
; а права администратора Skvoz запрашивает сам при запуске
!macro customInstallMode
  StrCpy $isForceCurrentInstall "1"
!macroend

!macro customWelcomePage
  !insertmacro skipPageIfUpdated
  !define MUI_WELCOMEPAGE_TITLE "Установка Skvoz"
  !define MUI_WELCOMEPAGE_TEXT "Skvoz — пульт для zapret: обход блокировок YouTube и Discord, Telegram-прокси и VPN в одном окне.$\r$\n$\r$\nZapret скачается при первом запуске, а рабочий конфиг подберётся автоматически.$\r$\n$\r$\nНажмите «Далее», чтобы продолжить."
  !insertmacro MUI_PAGE_WELCOME
!macroend

!macro customFinishPage
  Function StartApp
    ${if} ${isUpdated}
      StrCpy $1 "--updated"
    ${else}
      StrCpy $1 ""
    ${endif}
    ${StdUtils.ExecShellAsUser} $0 "$launchLink" "open" "$1"
  FunctionEnd

  !define MUI_FINISHPAGE_TITLE "Skvoz установлен"
  !define MUI_FINISHPAGE_TEXT "Ярлык появился на рабочем столе и в меню «Пуск».$\r$\n$\r$\nПри запуске Windows спросит права администратора — без них zapret не сможет пропускать трафик в обход блокировок."
  !define MUI_FINISHPAGE_RUN
  !define MUI_FINISHPAGE_RUN_TEXT "Запустить Skvoz"
  !define MUI_FINISHPAGE_RUN_FUNCTION "StartApp"
  !insertmacro MUI_PAGE_FINISH
!macroend

!macro customUnWelcomePage
  !define MUI_WELCOMEPAGE_TITLE "Удаление Skvoz"
  !define MUI_WELCOMEPAGE_TEXT "Skvoz будет удалён с компьютера.$\r$\n$\r$\nПапка zapret со списками доменов останется на месте. Чтобы убрать и её, перед удалением откройте Skvoz → «Сервис» → «Удалить с ПК».$\r$\n$\r$\nНажмите «Далее», чтобы продолжить."
  !insertmacro MUI_UNPAGE_WELCOME
!macroend

; Старые версии качали zapret внутрь папки установки. Пока winws.exe оттуда запущен,
; его файлы не перенести, и удаление или обновление обрывается на середине
!macro customUnInit
  nsExec::Exec `powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$$dir = '$INSTDIR\'; Get-Process winws -ErrorAction SilentlyContinue | Where-Object { $$_.Path -and $$_.Path.StartsWith($$dir, 'OrdinalIgnoreCase') } | Stop-Process -Force"`
  Pop $0
!macroend

!macro customUnInstall
  ; при обновлении старая версия удаляется молча — настройки, конечно, не трогаем
  ${ifNot} ${isUpdated}
    MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 "Удалить и настройки Skvoz?$\r$\n$\r$\nКонфиг, история событий, секрет Telegram-прокси и ключи VPN. Если собираетесь поставить Skvoz снова — нажмите «Нет»." /SD IDNO IDNO skvozKeepUserData
      SetShellVarContext current
      RMDir /r "$APPDATA\zapret-app"
    skvozKeepUserData:
  ${endIf}
!macroend
