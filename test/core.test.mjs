import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import sharp from "sharp";
import { cleanBackgroundBuffer } from "../lib/clean-bg.js";
import { runPackPipeline } from "../lib/pack-pipeline.js";
import { verifyFrameIdentity } from "../lib/verify-identity.js";

function withTemp(run) {
  const root = mkdtempSync(join(tmpdir(), "sprite-generator-test-"));
  return Promise.resolve(run(root)).finally(() => rmSync(root, { recursive: true, force: true }));
}

async function syntheticFrame({ width = 64, height = 64, left = 20, top = 14 } = {}) {
  const subject = await sharp({
    create: { width: 16, height: 28, channels: 4, background: { r: 25, g: 90, b: 220, alpha: 1 } }
  }).png().toBuffer();
  return sharp({
    create: { width, height, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 0 } }
  }).composite([{ input: subject, left, top }]).png().toBuffer();
}

test("background cleanup removes the connected field and preserves the subject", async () => {
  const subject = await sharp({
    create: { width: 8, height: 8, channels: 4, background: { r: 20, g: 80, b: 220, alpha: 1 } }
  }).png().toBuffer();
  const input = await sharp({
    create: { width: 24, height: 24, channels: 4, background: { r: 250, g: 250, b: 250, alpha: 1 } }
  }).composite([{ input: subject, left: 8, top: 8 }]).png().toBuffer();

  const cleaned = await cleanBackgroundBuffer(input, { threshold: 20 });
  const { data, info } = await sharp(cleaned).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const alpha = (x, y) => data[(y * info.width + x) * info.channels + 3];
  assert.equal(alpha(0, 0), 0);
  assert.equal(alpha(12, 12), 255);
});

test("identity verification accepts a stable pair and rejects a displaced frame", () => withTemp(async (root) => {
  const first = join(root, "first.png");
  const same = join(root, "same.png");
  const shifted = join(root, "shifted.png");
  writeFileSync(first, await syntheticFrame());
  writeFileSync(same, await syntheticFrame());
  writeFileSync(shifted, await syntheticFrame({ left: 42 }));

  const accepted = await verifyFrameIdentity([first, same]);
  assert.equal(accepted.pass, true);
  assert.equal(accepted.minNCC, 1);

  const rejected = await verifyFrameIdentity([first, shifted]);
  assert.equal(rejected.pass, false);
  assert.match(rejected.failures.join("\n"), /Spatial drift|Identity NCC/);
}));

test("pack pipeline assembles synthetic frames to exact target geometry", () => withTemp(async (root) => {
  const rawDir = join(root, "raw");
  const outputDir = join(root, "output");
  mkdirSync(rawDir, { recursive: true });

  const pose = await sharp({
    create: { width: 14, height: 24, channels: 4, background: { r: 220, g: 60, b: 30, alpha: 1 } }
  }).png().toBuffer();
  const raw = await sharp({
    create: { width: 72, height: 40, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 0 } }
  }).composite([
    { input: pose, left: 6, top: 8 },
    { input: pose, left: 48, top: 8 }
  ]).png().toBuffer();
  writeFileSync(join(rawDir, "hero.png"), raw);

  const spec = {
    defaultStyle: "synthetic fixture",
    assets: [{
      id: "hero",
      name: "Hero",
      frames: 2,
      layout: "character",
      targetFrameWidth: 20,
      targetFrameHeight: 30,
      cleanBg: false,
      verifyIdentity: true
    }]
  };
  const { pack, results } = await runPackPipeline({
    spec,
    outputDir,
    rawDir,
    skipGenerate: true,
    log: () => {}
  });
  assert.equal(results[0].status, "ok");
  assert.equal(pack.hero.frames, 2);
  assert.equal(pack.hero.frameWidth, 20);
  assert.equal(pack.hero.frameHeight, 30);
  assert.equal(pack.hero.verification.pass, true);
  const metadata = await sharp(join(outputDir, "hero.png")).metadata();
  assert.equal(metadata.width, 40);
  assert.equal(metadata.height, 30);
  assert.deepEqual(JSON.parse(readFileSync(join(outputDir, "pack.json"), "utf8")).hero.frames, 2);
}));

test("dry run resolves prompts without a provider credential", () => withTemp(async (root) => {
  const manifest = join(root, "manifest.json");
  writeFileSync(manifest, JSON.stringify({
    defaultStyle: "flat test sprite",
    assets: [{ id: "token", name: "Token", category: "item", description: "a blue token" }]
  }));
  const result = spawnSync(
    process.execPath,
    ["generate.js", "--manifest", manifest, "--output", join(root, "out"), "--dry-run"],
    { cwd: process.cwd(), encoding: "utf8", env: { ...process.env, OPENAI_API_KEY: "" } }
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /would generate 1 sprites/);
  assert.match(result.stdout, /flat test sprite\. a blue token\./);
}));
