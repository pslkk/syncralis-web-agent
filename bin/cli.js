#!/usr/bin/env node
import { createRequire } from "node:module";
import { startServer } from "../src/index.js";

const require = createRequire(import.meta.url);
const pkg = require("../package.json");

if (process.argv.includes('--version') || process.argv.includes('-v')) {
  console.log(`openclaw-syncralis v${pkg.version}`);
  process.exit(0);
}

startServer().catch((err) => {
  console.error("[syncralis-web-agent] fatal error:", err);
  process.exit(1);
});
