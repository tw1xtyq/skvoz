// Игровой режим: пока запущена игра, сторож обхода проверяет сайты реже и не перебирает
// конфиги — каждый перезапуск winws рвёт соединение с игровым сервером.

/** Популярные онлайн-игры, у которых exe не подпадает под шаблон Unreal Engine */
const KNOWN_GAMES = new Set(
  [
    'cs2.exe',
    'csgo.exe',
    'dota2.exe',
    'r5apex.exe',
    'r5apex_dx12.exe',
    'gta5.exe',
    'gta5_enhanced.exe',
    'playgtav.exe',
    'rdr2.exe',
    'rustclient.exe',
    'league of legends.exe',
    'overwatch.exe',
    'tslgame.exe',
    'destiny2.exe',
    'rainbowsix.exe',
    'rainbowsix_vulkan.exe',
    'eldenring.exe',
    'warframe.x64.exe',
    'worldoftanks.exe',
    'wotblitz.exe',
    'escapefromtarkov.exe',
    'cod.exe',
    'deadlock.exe',
    'project8.exe',
    'robloxplayerbeta.exe',
    'genshinimpact.exe',
    'starrail.exe',
    'zenlesszonezero.exe',
    'minecraft.windows.exe',
    'helldivers2.exe',
    'bf2042.exe',
    'bf6.exe',
    'pathofexile_x64.exe',
    'pathofexile_x64steam.exe',
    'pathofexilesteam.exe',
    'wow.exe',
    'diablo iv.exe',
    'hearthstone.exe',
    'arma3_x64.exe',
    'dayz_x64.exe',
    'rocketleague.exe',
    'fc25.exe',
    'fc26.exe',
    'aces.exe',
    'lostark.exe',
    'cyberpunk2077.exe',
    'bg3.exe',
    'bg3_dx11.exe',
    'osu!.exe',
    'among us.exe',
    'terraria.exe',
    'eurotrucks2.exe',
    'amtrucks.exe',
    'witcher3.exe',
    'phasmophobia.exe',
    'lethal company.exe',
  ]
);

/** Игры на Unreal Engine: Valorant, Fortnite, PUBG-клоны, Dead by Daylight, Marvel Rivals… */
const UNREAL_SHIPPING = /-win64-shipping\.exe$/i;

/** «CS2», «cs2.exe», «C:\Games\cs2.exe» → «cs2.exe»; мусор → null */
export function normalizeGameProcess(value: string): string | null {
  const base = value.trim().split(/[\\/]/).pop()?.trim().toLowerCase() ?? '';
  if (!base) return null;
  const name = base.endsWith('.exe') ? base : `${base}.exe`;
  if (name.length > 80 || !/^[\p{L}\p{N} _.!()+\-]+\.exe$/u.test(name)) return null;
  return name;
}

export function isGameProcess(name: string, custom: readonly string[] = []): boolean {
  const lower = name.toLowerCase();
  return KNOWN_GAMES.has(lower) || UNREAL_SHIPPING.test(lower) || custom.includes(lower);
}

/** Имена процессов из вывода `tasklist /FO CSV /NH` */
export function parseTasklistNames(output: string): string[] {
  const names: string[] = [];
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/^"([^"]+)"/);
    if (match) names.push(match[1]);
  }
  return names;
}

export function findRunningGame(names: readonly string[], custom: readonly string[] = []): string | null {
  return names.find((name) => isGameProcess(name, custom)) ?? null;
}

/** «VALORANT-Win64-Shipping.exe» → «VALORANT» — для трея и журнала */
export function gameLabel(processName: string): string {
  return processName.replace(UNREAL_SHIPPING, '').replace(/\.exe$/i, '');
}

export interface GameDetectorOptions {
  intervalMs?: number;
  isEnabled: () => boolean;
  customProcesses: () => string[];
  /** null — не удалось получить список процессов */
  listProcesses: () => Promise<string[] | null>;
  onChange: (game: string | null, previous: string | null) => void;
}

export class GameDetector {
  private timer: ReturnType<typeof setInterval> | null = null;
  private game: string | null = null;
  private polling = false;

  constructor(private readonly options: GameDetectorOptions) {}

  /** exe запущенной игры, если игровой режим включён */
  get current(): string | null {
    return this.game;
  }

  start(): void {
    if (this.timer) return;
    void this.poll();
    this.timer = setInterval(() => void this.poll(), this.options.intervalMs ?? 20_000);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async poll(): Promise<string | null> {
    if (this.polling) return this.game;
    this.polling = true;
    try {
      let next: string | null = null;
      if (this.options.isEnabled()) {
        const names = await this.options.listProcesses();
        // не узнали — оставляем как было, чтобы режим не мигал
        if (names === null) return this.game;
        next = findRunningGame(names, this.options.customProcesses());
      }
      if (next !== this.game) {
        const previous = this.game;
        this.game = next;
        this.options.onChange(next, previous);
      }
      return this.game;
    } finally {
      this.polling = false;
    }
  }
}
