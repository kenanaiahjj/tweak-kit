// .ui-tweaks/.gitignore: everything in .ui-tweaks stays out of git except what the team shares: the canvas,
// comments and the flow map.
export const GITIGNORE = [
  "*",
  "!.gitignore",
  "!canvas.json",
  "!comments.json",
  "!flows.json",
  "",
].join("\n");
