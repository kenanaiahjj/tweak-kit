import type { Plugin } from "vite";

export interface UiTweaksOptions {
  /** Reinstall the kit from GitHub when a newer version is out (restart the dev server afterwards). Default true; false only notifies. */
  autoUpdate?: boolean;
  /** Check GitHub for a newer kit when the dev server starts. Default true. */
  updateCheck?: boolean;
  /** Keep where each JSX element was written (needed on React 19) by wrapping react/jsx-dev-runtime in dev. Default true. */
  sources?: boolean;
}

export default function uiTweaks(options?: UiTweaksOptions): Plugin[];
