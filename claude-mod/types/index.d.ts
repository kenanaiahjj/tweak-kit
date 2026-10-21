export type SkippedTweak = { id: string; reason: string }

export type PendingTweaks = {
  tweakIds: string[]
  elements: number
  changes: number
  pages: string[]
  skipped: SkippedTweak[]
}

/** A run applying tweaks: Haiku in the background, or the main model's turn. */
export type TweakRun = { by: 'haiku' | 'claude'; tweakIds: string[]; agentId?: string; startedAt: number }

export type FileStat = { path: string; added: number; removed: number }

/** The newest undoable apply, from .ui-tweaks/history.json: by Haiku, or directly by the dev server. */
export type LastApply = { id: string; by: 'haiku' | 'direct' | 'claude' | 'tokens'; count: number; files: FileStat[] }

/** An "Ask Claude" request being run: a designer editing the code, or variations being proposed. */
export type AskRun = { id: string; kind: 'edit' | 'variations'; agentId?: string; startedAt: number }

/** What the Diff pane shows: the newest apply's unified diffs. */
export type DiffView = { id: string; files: { path: string; diff: string }[] }

declare module 'claude-code' {
  interface PluginState {
    'ui-tweaks': {
      pending: PendingTweaks | null
      run: TweakRun | null
      attempted: string[]
      lastApply: LastApply | null
      dismissedApply: string | null
      diffView: DiffView | null
      askRun: AskRun | null
    }
  }
}
