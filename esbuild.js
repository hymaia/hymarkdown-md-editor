const esbuild = require("esbuild");

const watch = process.argv.includes("--watch");

const common = {
  bundle: true,
  sourcemap: true,
  logLevel: "info"
};

const builds = [
  esbuild.context({
    ...common,
    entryPoints: ["src/extension.ts"],
    external: ["vscode"],
    format: "cjs",
    platform: "node",
    outfile: "dist/extension.js"
  }),
  esbuild.context({
    ...common,
    entryPoints: ["media/editor.ts"],
    format: "iife",
    globalName: "MarkdownWysiwygEditor",
    platform: "browser",
    outfile: "dist/editor.js"
  })
];

Promise.all(builds)
  .then(async contexts => {
    if (watch) {
      await Promise.all(contexts.map(context => context.watch()));
      return;
    }

    await Promise.all(contexts.map(context => context.rebuild()));
    await Promise.all(contexts.map(context => context.dispose()));
  })
  .catch(error => {
    console.error(error);
    process.exit(1);
  });
