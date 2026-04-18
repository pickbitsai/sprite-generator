/**
 * File-level check of themed background assets. Confirms every level has:
 *   - level<N>-scene.png (single 16:9 source, 1536×1024-ish)
 *   - level<N>-{bg,mid,ground}.png sliced layers at the expected size
 *   - sufficient opaque / non-blank content (catches "sharp produced a
 *     blank PNG" or "generator returned a transparent frame" regressions)
 *
 * Does NOT run the game — that's what validate-theme / verify-gameplay do.
 * This gate only asserts the on-disk assets the engine will later read.
 *
 * Exit 0 on pass, 2 otherwise.
 *
 * Usage: node tools/theme/verify-backgrounds.js <theme-id>
 */
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { loadThemeConfig, themeDir, parseThemeIdFromArgs } = require('./lib');

const EXPECTED_LAYER_W = 1536;
const EXPECTED_LAYER_H = 1024;
// Content check: require at least 5% of pixels to be meaningfully non-black
// (scene) or non-transparent (layers). Catches blank / solid-color outputs.
const MIN_CONTENT_FRACTION = 0.05;

async function measure(filePath, mode) {
  const { data, info } = await sharp(filePath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let kept = 0;
  const N = info.width * info.height;
  for (let i = 0; i < N; i++) {
    const o = i * info.channels;
    const a = data[o + 3];
    if (mode === 'transparent') {
      if (a > 30) kept++;
    } else {
      // 'luminance' — for scenes that are RGB with no alpha, count pixels
      // that aren't nearly black.
      const lum = data[o] + data[o + 1] + data[o + 2];
      if (a > 30 && lum > 60) kept++;
    }
  }
  return { width: info.width, height: info.height, kept, total: N, fraction: kept / N };
}

async function main() {
  const themeId = parseThemeIdFromArgs(process.argv);
  const config = loadThemeConfig(themeId);
  const bgDir = path.join(themeDir(themeId), 'bg');

  console.log(`[verify-backgrounds] theme=${themeId}`);

  const failures = [];
  let checked = 0;
  for (let level = 1; level <= config.levels.length; level++) {
    const scene = path.join(bgDir, `level${level}-scene.png`);
    const layers = ['bg', 'mid', 'ground'].map(k => ({ kind: k, file: path.join(bgDir, `level${level}-${k}.png`) }));

    if (!fs.existsSync(scene)) {
      failures.push(`level${level}-scene.png missing`);
    } else {
      checked++;
      const m = await measure(scene, 'luminance');
      if (m.fraction < MIN_CONTENT_FRACTION) {
        failures.push(`level${level}-scene.png near-blank (${(m.fraction * 100).toFixed(1)}% non-black)`);
      } else {
        console.log(`  OK scene  level${level}  ${m.width}×${m.height}  content=${(m.fraction * 100).toFixed(1)}%`);
      }
    }

    for (const { kind, file } of layers) {
      if (!fs.existsSync(file)) { failures.push(`level${level}-${kind}.png missing`); continue; }
      checked++;
      const m = await measure(file, 'luminance');
      const sizeOK = m.width === EXPECTED_LAYER_W && m.height === EXPECTED_LAYER_H;
      if (!sizeOK) {
        failures.push(`level${level}-${kind}.png wrong size ${m.width}×${m.height} (expected ${EXPECTED_LAYER_W}×${EXPECTED_LAYER_H})`);
      } else if (m.fraction < MIN_CONTENT_FRACTION) {
        failures.push(`level${level}-${kind}.png near-blank (${(m.fraction * 100).toFixed(1)}% non-black)`);
      } else {
        console.log(`  OK ${kind.padEnd(6)} level${level}  ${m.width}×${m.height}  content=${(m.fraction * 100).toFixed(1)}%`);
      }
    }
  }

  console.log(`[verify-backgrounds] checked ${checked}  fail=${failures.length}`);
  if (failures.length) {
    for (const f of failures) console.log(`  FAIL  ${f}`);
    console.log(`[verify-backgrounds] Rerun backgrounds stage with --force (or delete the failing file) to regenerate.`);
    process.exit(2);
  }
  console.log(`[verify-backgrounds] PASSED.`);
}

if (require.main === module) {
  main().catch(e => { console.error('[verify-backgrounds] FAILED:', e.message); process.exit(1); });
}

module.exports = { main };
