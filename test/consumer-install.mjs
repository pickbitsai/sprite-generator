import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sandbox = mkdtempSync(join(tmpdir(), "sprite-generator-consumer-"));
const consumer = join(sandbox, "consumer");
const npmCli = process.env.npm_execpath;
const env = { ...process.env, NPM_CONFIG_CACHE: join(sandbox, "npm-cache") };
assert.ok(npmCli, "npm_execpath is required; run this check through npm");

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
  assert.equal(
    result.status,
    0,
    `${command} ${args.join(" ")} failed\n${result.stdout}\n${result.stderr}`
  );
  return result.stdout;
}

function runNpm(args, cwd) {
  return run(process.execPath, [npmCli, ...args], cwd);
}

try {
  mkdirSync(consumer, { recursive: true });
  writeFileSync(
    join(consumer, "package.json"),
    JSON.stringify({ name: "sprite-generator-consumer-smoke", private: true }, null, 2)
  );

  const packed = JSON.parse(
    runNpm(["pack", "--json", "--ignore-scripts", "--pack-destination", sandbox], root)
  );
  assert.equal(packed.length, 1);
  const tarball = join(sandbox, basename(packed[0].filename));
  assert.ok(existsSync(tarball), `missing packed tarball: ${tarball}`);

  runNpm(
    ["install", "--prefer-offline", "--ignore-scripts", "--no-audit", "--no-fund", tarball],
    consumer
  );
  const init = runNpm(["exec", "--", "sprite-generator", "init", "--template", "shmup"], consumer);
  assert.match(init, /shmup template/);
  assert.ok(existsSync(join(consumer, "manifest.json")));

  const dry = runNpm(["exec", "--", "sprite-generator", "--dry-run"], consumer);
  assert.match(dry, /Dry run/);
  assert.doesNotMatch(dry, /Missing OPENAI_API_KEY/);

  console.log("consumer smoke passed: packed, installed, initialized, and dry-ran without provider access");
} finally {
  rmSync(sandbox, { recursive: true, force: true });
}
