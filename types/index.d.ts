export type Limit = { kind: string; percent: number; resetsAt?: string }

export type Segment = { name: string; tokens: number; color: string; kind: 'used' | 'free' | 'buffer' }

export type Snapshot = {
  /** The windows the engine reports (five_hour, seven_day). */
  limits: Limit[]
  /** Context fill, 0 to 100, against the compaction window when a breakdown came back. */
  percent?: number
  tokens?: number
  window: number
  segments: Segment[]
}

/** The account's windows as the usage endpoint lists them, per-model ones included. */
export type Account = { limits: Limit[]; fetchedAt: number; raw: string }

declare module 'claude-code' {
  interface PluginState {
    'usage-bars': { snapshot: Snapshot | null; account: Account | null; now: number; frame: number }
  }
}
