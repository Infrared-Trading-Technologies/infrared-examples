import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Address } from "viem";

export interface UserState {
  chainId: number;
  slippageBps: number;
  /** WalletConnect session topic once the user has connected a wallet. */
  wcTopic?: string;
  address?: Address;
}

/** Per-Telegram-user settings in one JSON file with atomic writes. Small by design: sessions live in WalletConnect's own storage. */
export class UserStore {
  private users = new Map<number, UserState>();

  constructor(
    private readonly path: string,
    private readonly defaults: { chainId: number; slippageBps: number },
  ) {
    try {
      const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, UserState>;
      this.users = new Map(Object.entries(raw).map(([k, v]) => [Number(k), v]));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }

  get(userId: number): UserState {
    let u = this.users.get(userId);
    if (!u) {
      u = { chainId: this.defaults.chainId, slippageBps: this.defaults.slippageBps };
      this.users.set(userId, u);
    }
    return u;
  }

  update(userId: number, patch: Partial<UserState>): UserState {
    const u = { ...this.get(userId), ...patch };
    for (const k of Object.keys(patch) as (keyof UserState)[]) if (patch[k] === undefined) delete u[k];
    this.users.set(userId, u);
    this.flush();
    return u;
  }

  all(): [number, UserState][] {
    return [...this.users.entries()];
  }

  private flush(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(Object.fromEntries(this.users), null, 2));
    renameSync(tmp, this.path);
  }
}
