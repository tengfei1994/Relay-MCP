import { fileURLToPath } from "node:url";
import { build } from "vite";
import config from "./vite.config.ts";

// Vite's CLI bundles vite.config.ts with esbuild before loading it. That
// config-bundling step walks parent directories through OneDrive reparse
// points and fails on Windows. Loading the config through tsx and disabling
// the secondary config discovery keeps the build rooted in this workspace.
const frontendRoot = fileURLToPath(new URL(".", import.meta.url));
process.chdir(frontendRoot);
await build({ ...config, configFile: false, root: frontendRoot });
