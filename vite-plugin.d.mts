import type { Plugin } from "vite";

export interface UiTweaksOptions {
  /** Reinstall the kit from GitHub when a newer version is out (restart the dev server afterwards). Default true; false only tells you, and you run the command yourself. */
  autoUpdate?: boolean;
  /** Commit what a Send writes directly, one commit per Send, but only files that had no uncommitted changes. Default false. */
  commit?: boolean;
  /** Check GitHub for a newer kit when the dev server starts. Default true. */
  updateCheck?: boolean;
  /** Keep where each JSX element was written (needed on React 19) by wrapping react/jsx-dev-runtime in dev. Default true. */
  sources?: boolean;
}

export default function uiTweaks(options?: UiTweaksOptions): Plugin[];
