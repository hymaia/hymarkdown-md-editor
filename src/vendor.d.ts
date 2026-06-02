declare module "markdown-it-task-lists";

declare module "markdown-it-texmath";

declare module "turndown-plugin-gfm" {
  import TurndownService = require("turndown");

  export function gfm(service: TurndownService): void;
}
