"use strict";
const base = require("./electron-builder.cjs");
module.exports = {
  ...base,
  directories: { ...base.directories, output: "dist/electron-out-mac" },
  extraMetadata: { main: "electron/main.mac.cjs" },
  files: ["electron/main.mac.cjs", "electron/preload.mac.cjs", "package.json"],
  extraResources: [
    { from: "build/app.cjs", to: "edexo/app.cjs" },
    { from: "dist/mac-staging/web", to: "web" },
    { from: "dist/mac-staging/data", to: "data" },
    { from: "dist/mac-staging/sql-wasm", to: "sql-wasm" },
  ],
  mac: {
    target: ["dir"],
    icon: "public/edexo-icon.png",
    category: "public.app-category.utilities",
    artifactName: "EDExoCompare-${version}-macos-${arch}.${ext}",
  },
};
