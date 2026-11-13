// .ui-tweaks/.gitignore: everything in .ui-tweaks stays out of git except what the team shares: the canvas
// and the flow map.
export const GITIGNORE = [
  "*",
  "!.gitignore",
  "!canvas.json",
  "!flows.json",
  "",
].join("\n");
