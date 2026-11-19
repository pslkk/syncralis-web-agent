#!/usr/bin/env node
import { main } from "../src/http/main.js";

main().catch((err) => {
  console.error("[syncralis-web-agent] fatal error:", err);
  process.exit(1);
});
