#!/usr/bin/env node
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const TEXT_EXT = new Set([".mjs", ".js", ".json", ".md", ".html", ".css", ".txt", ".yml", ".yaml", ""]);
const SKIP_DIRS = new Set(["node_modules", ".git"]);
const RULES = [
  { id: "abs-win-path", re: /[A-Za-z]:\\(?:new|Users)\b/i, note: "absolute Windows path" },
  { id: "abs-home-path", re: /\/(?:Users|home)\/[a-z0-9._-]+\//i, note: "absolute home path" },
  { id: "api-key-literal", re: /\b(?:sk-[A-Za-z0-9]{16,}|gh[pousr]_[A-Za-z0-9]{16,}|xox[baprs]-[A-Za-z0-9-]{10,})/, note: "credential literal" },
  { id: "generic-secret", re: /\b(?:api[_-]?key|access[_-]?token|client[_-]?secret)\s*[:=]\s*["'][^"'{}\s]{12,}["']/i, note: "assigned secret" },
  { id: "private-game-script", re: /\b(?:GAME_ROOT|UE5-Survival|Street Fury)\b/i, note: "game-specific production coupling" },
  { id: "private-theme-dir", re: /(?:^|[/\\])theme[/\\]/i, note: "private theme pipeline path" }
];

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

const staged = [];
for (const pattern of pkg.files) {
  const target = join(ROOT, pattern.replace(/\/$/, ""));
  try {
    if (statSync(target).isDirectory()) staged.push(...walk(target));
    else staged.push(target);
  } catch {
    console.warn(`files entry does not exist: ${pattern}`);
  }
}

const findings = [];
let scanned = 0;
for (const file of staged) {
  if (!TEXT_EXT.has(extname(file))) continue;
  scanned++;
  const rel = relative(ROOT, file).replace(/\\/g, "/");
  const lines = readFileSync(file, "utf8").split(/\r?\n/);
  for (const rule of RULES) {
    lines.forEach((line, index) => {
      if (rule.re.test(line)) {
        findings.push({ rel, line: index + 1, rule, text: line.trim().slice(0, 120) });
      }
    });
  }
}

console.log(`leakscan: ${scanned} publishable text files, ${RULES.length} rules`);
if (!findings.length) {
  console.log("PASS — no private production coupling in the publish set.");
  process.exit(0);
}

for (const finding of findings) {
  console.log(
    `\n${finding.rel}:${finding.line} [${finding.rule.id}] ${finding.rule.note}\n  ${finding.text}`
  );
}
console.log(`\nFAIL — ${findings.length} finding(s).`);
process.exit(1);
