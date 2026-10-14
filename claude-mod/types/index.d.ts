export type SkippedTweak = { id: string; reason: string }

export type PendingTweaks = {
  tweakIds: string[]
  elements: number
  changes: number
  pages: string[]
  skipped: SkippedTweak[]
}

/** A run applying tweaks: Haiku in the background, or the main model's turn. */
export type TweakRun = { by: 'haiku' | 'claude'; tweakIds: string[]; agentId?: string }

declare module 'claude-code' {
  interface PluginState {
    'ui-tweaks': { pending: PendingTweaks | null; run: TweakRun | null }
  }
}
