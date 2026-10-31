import { app } from 'electron';
import path from 'path';

/**
 * Папка настроек не должна зависеть от отображаемого названия приложения:
 * после переименования пользователи сохраняют конфиг, списки и секрет прокси.
 * Импортируется первым — до модулей, которые читают userData при загрузке.
 */
const USER_DATA_DIR = 'zapret-app';

app.setPath('userData', path.join(app.getPath('appData'), USER_DATA_DIR));
