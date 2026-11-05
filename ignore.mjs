// .ui-tweaks/.gitignore: everything in .ui-tweaks stays out of git except what the team shares: the canvas,
// comments, the flow map, and the handoff's versions (their index, screens and stylesheets; not the
// exported files or the folder a share deploys from).
export const GITIGNORE = [
  "*",
  "!.gitignore",
  "!canvas.json",
  "!comments.json",
  "!flows.json",
  "!handoff/",
  "!handoff/index.json",
  "!handoff/screens/",
  "!handoff/screens/*.html",
  "!handoff/styles/",
  "!handoff/styles/*.css",
  "",
].join("\n");
