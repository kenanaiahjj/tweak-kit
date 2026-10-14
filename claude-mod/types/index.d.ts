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
export type LastApply = { id: string; by: 'haiku' | 'direct'; count: number; files: FileStat[] }

/** What the Diff pane shows: the newest apply's unified diffs. */
export type DiffView = { id: string; files: { path: string; diff: string }[] }

/** One field's value in the page, as the overlay reports it. */
export type RemoteField = { value: string; changed: boolean }

/** What the page's overlay reports to the Claude Code pane: the selection and everything the panel shows. */
export type RemoteSnapshot = {
  open: boolean
  page: string
  width: number
  picking: boolean
  editState: string
  undoCount: number
  lastApply: { id: string; by?: string; count: number; files: string[] } | null
  note: string
  changes: { key: string; label: string; summary: string; status: 'draft' | 'applying' | 'skipped'; reason?: string }[]
  tokens: { name: string; value: string }[]
  selected: null | {
    name: string
    source?: string
    isFlex: boolean
    isGrid: boolean
    hasText: boolean
    hasGradient: boolean
    scope: 'all' | 'viewport'
    note: string
    warnings: string[]
    fields: Record<string, RemoteField>
  }
  layers?: { depth: number; name: string; text: string; kind: string; selected: boolean; changed: boolean }[]
}

declare module 'claude-code' {
  interface PluginState {
    'ui-tweaks': {
      pending: PendingTweaks | null
      run: TweakRun | null
      attempted: string[]
      lastApply: LastApply | null
      dismissedApply: string | null
      diffView: DiffView | null
      remote: RemoteSnapshot | null
      remotePages: number
      paneOpen: boolean
    }
  }
}
