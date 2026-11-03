import fs from 'fs';
import path from 'path';
import type { StrategyRanking } from './tests-runner';

export interface NetworkProfile {
  id: string;
  label: string;
  /** папка zapret, на которой получен рейтинг: после обновления конфиги другие */
  root: string | null;
  rankings: StrategyRanking[];
  rankedAt: number | null;
  /** конфиг, который работал в этой сети последним */
  selected: string | null;
  /** конфиг → до какого времени (ms) не пробовать его как запасной */
  bad: Record<string, number>;
  seenAt: number;
}

interface MemoryFile {
  version: 1;
  profiles: Record<string, NetworkProfile>;
}

const MAX_PROFILES = 20;

/** Рейтинги конфигов, отложенные конфиги и последний рабочий конфиг — отдельно для каждой сети. */
export class StrategyMemory {
  private data: MemoryFile;

  constructor(
    private readonly filePath: string | null,
    private readonly now: () => number = () => Date.now()
  ) {
    this.data = this.load();
  }

  getProfile(id: string): NetworkProfile | null {
    return this.data.profiles[id] ?? null;
  }

  listProfiles(): NetworkProfile[] {
    return Object.values(this.data.profiles).sort((a, b) => b.seenAt - a.seenAt);
  }

  touch(id: string, label: string): NetworkProfile {
    const profile = this.ensure(id, label);
    this.persist();
    return profile;
  }

  /** Рейтинг текущей сети; если он снят на другой папке zapret — его как будто нет */
  getRankings(id: string, root: string): StrategyRanking[] {
    const profile = this.getProfile(id);
    return profile && profile.root === root ? profile.rankings : [];
  }

  rankedAt(id: string, root: string): number | null {
    const profile = this.getProfile(id);
    return profile && profile.root === root ? profile.rankedAt : null;
  }

  /** full — проверены все конфиги: старые отметки «не работает» больше не нужны */
  saveRankings(id: string, label: string, root: string, rankings: StrategyRanking[], full: boolean): void {
    const profile = this.ensure(id, label);
    if (profile.root !== root || full) {
      profile.bad = {};
      profile.rankings = rankings;
    } else {
      // быстрый подбор проверил только часть конфигов — обновляем их, остальные оставляем
      const byName = new Map(profile.rankings.map((r) => [r.strategy, r]));
      for (const ranking of rankings) byName.set(ranking.strategy, ranking);
      profile.rankings = [...byName.values()].sort((a, b) => b.score - a.score || b.okChecks - a.okChecks);
    }
    profile.root = root;
    profile.rankedAt = this.now();
    this.persist();
  }

  rememberSelected(id: string, label: string, strategy: string | null): void {
    const profile = this.ensure(id, label);
    if (profile.selected === strategy) return;
    profile.selected = strategy;
    this.persist();
  }

  isBad(id: string, root: string, strategy: string): boolean {
    const profile = this.getProfile(id);
    if (!profile || profile.root !== root) return false;
    const until = profile.bad[strategy];
    return !!until && until > this.now();
  }

  markBad(id: string, label: string, root: string, strategy: string, ttlMs: number): void {
    const profile = this.ensure(id, label);
    if (profile.root !== root) {
      profile.root = root;
      profile.rankings = [];
      profile.rankedAt = null;
      profile.bad = {};
    }
    const now = this.now();
    for (const [name, until] of Object.entries(profile.bad)) {
      if (until <= now) delete profile.bad[name];
    }
    profile.bad[strategy] = now + ttlMs;
    this.persist();
  }

  /** zapret обновился — рейтинги и отметки относятся к старым .bat */
  forgetRankings(): void {
    for (const profile of Object.values(this.data.profiles)) {
      profile.rankings = [];
      profile.rankedAt = null;
      profile.bad = {};
      profile.root = null;
    }
    this.persist();
  }

  private ensure(id: string, label: string): NetworkProfile {
    let profile = this.data.profiles[id];
    if (!profile) {
      profile = { id, label, root: null, rankings: [], rankedAt: null, selected: null, bad: {}, seenAt: this.now() };
      this.data.profiles[id] = profile;
    }
    profile.label = label;
    profile.seenAt = this.now();
    return profile;
  }

  private load(): MemoryFile {
    if (!this.filePath) return { version: 1, profiles: {} };
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as MemoryFile;
      if (parsed?.version === 1 && parsed.profiles && typeof parsed.profiles === 'object') return parsed;
    } catch {
      /* файла ещё нет или он битый — начинаем с чистого */
    }
    return { version: 1, profiles: {} };
  }

  private persist(): void {
    const profiles = this.listProfiles();
    if (profiles.length > MAX_PROFILES) {
      for (const stale of profiles.slice(MAX_PROFILES)) delete this.data.profiles[stale.id];
    }
    if (!this.filePath) return;
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2), 'utf8');
    } catch {
      /* память — только для удобства */
    }
  }
}
