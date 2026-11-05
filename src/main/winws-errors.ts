/** Коды ошибок открытия WinDivert из его документации */
const WINDIVERT_HINTS: Record<number, string> = {
  2: 'нет файла драйвера WinDivert64.sys — его мог удалить антивирус, переустановите zapret',
  5: 'нет прав на загрузку драйвера WinDivert — запустите Skvoz от администратора и проверьте антивирус',
  577: 'Windows не приняла подпись драйвера WinDivert — проверьте, что антивирус не изменил файл',
  654: 'драйвер WinDivert не выгрузился после прошлого запуска — перезагрузите компьютер',
  1060: 'служба WinDivert удаляется — перезагрузите компьютер',
  1275: 'Windows заблокировала драйвер WinDivert — проверьте антивирус и «Целостность памяти» в настройках безопасности',
  1753: 'не работает служба базовой фильтрации (BFE) — включите её в services.msc',
};

/** Текст ошибки для winws.exe, который завершился сразу после запуска. */
export function describeWinwsExit(exitCode: number | null, output: string): string {
  const lines = output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const tail = lines.slice(-3).join(' · ').slice(0, 300);
  const windivertCode = output.match(/(?:windivert|filter)[^\n]*?(?:error|code|ошибка)\D{0,12}(\d{1,4})\b/i)?.[1];
  const hint = windivertCode ? WINDIVERT_HINTS[Number(windivertCode)] : undefined;

  if (hint) return `winws.exe не запустился: ${hint}. Вывод: ${tail}`;
  const reason = /access is denied|отказано в доступе/i.test(output)
    ? WINDIVERT_HINTS[5]
    : 'конфиг не подошёл или мешает другая DPI-утилита (GoodbyeDPI, второй zapret). Выберите другой конфиг';
  const details = tail ? ` Вывод: ${tail}` : '';
  return `winws.exe завершился сразу (код ${exitCode ?? '?'}): ${reason}.${details}`;
}
