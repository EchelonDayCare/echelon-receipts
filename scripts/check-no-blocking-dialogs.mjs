#!/usr/bin/env node
// Fails when raw `confirm(`, `alert(`, or `prompt(` calls sneak back into the
// frontend under src/. Those hit the WebView2 z-order bug on Windows — the
// native dialog spawns behind the app window and freezes the JS thread. Use
// showConfirm / showAlert / showPrompt from src/lib/dialogs.ts instead.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, extname, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../src", import.meta.url));
const EXTS = new Set([".ts", ".tsx"]);
// dialogs.ts wraps window.prompt as an intentional last-resort fallback.
const ALLOW = new Set([join("src", "lib", "dialogs.ts")]);
// Bare calls only — must be preceded by a non-identifier character so
// `showConfirm(`, `window.alert(`, `document.confirm(` don't match.
const RE = /(^|[\s({!;,&|?:=])(confirm|alert|prompt)\s*\(/;

const hits = [];
function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p);
    else if (EXTS.has(extname(name))) {
      const rel = relative(process.cwd(), p);
      if (ALLOW.has(rel.split(sep).join(sep))) continue;
      const lines = readFileSync(p, "utf8").split(/\r?\n/);
      lines.forEach((line, i) => {
        const stripped = line.replace(/\/\/.*$/, "").replace(/["'`][^"'`]*["'`]/g, '""');
        if (RE.test(stripped)) hits.push(`${rel}:${i + 1}: ${line.trim()}`);
      });
    }
  }
}
walk(ROOT);
if (hits.length) {
  console.error("\n❌ Blocking dialog call(s) found — use showConfirm/showAlert/showPrompt from src/lib/dialogs.ts:\n");
  for (const h of hits) console.error("  " + h);
  console.error(`\n${hits.length} violation(s).`);
  process.exit(1);
}
console.log("✅ No blocking dialogs in src/");
