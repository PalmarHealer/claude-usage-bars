export type Limit = { kind: string; percent: number; resetsAt?: string }

export type Segment = { name: string; tokens: number; color: string; kind: 'used' | 'free' | 'buffer' }

export type Snapshot = {
  limits: Limit[]
  /** Context fill, 0 to 100, against the compaction window when a breakdown came back. */
  percent?: number
  tokens?: number
  window: number
  segments: Segment[]
}

declare module 'claude-code' {
  interface PluginState {
    'usage-bars': { snapshot: Snapshot | null; now: number }
  }
}
