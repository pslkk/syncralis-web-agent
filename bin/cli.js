#!/usr/bin/env node
import { startServer } from "../src/index.js";

startServer().catch((err) => {
  console.error("[syncralis-web-agent] fatal error:", err);
  process.exit(1);
});
