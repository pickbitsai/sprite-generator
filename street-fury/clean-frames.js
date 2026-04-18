/**
 * Stage 5.4: Background cleaner.
 * Runs after characters/enemies/bosses and before validate-frames/assemble.
 * Imagen and gpt-image-1 return frames on a plain white background regardless
 * of what we ask for; this step flood-fills that background to transparent so
 * the downstream `regridSheet` (src/sprites.js) can separate rows by alpha
 * gaps. Without this, an 8-row sheet collapses into one big blob and
 * everything except idle/walk ends up blank.
 *
 * Flood-fill is seeded from the image border so white regions INSIDE the
 * character (e.g., eye highlights, Homer's shirt) are preserved.
 *
 * Usage:
 *   node tools/theme/clean-frames.js <theme-id>
 *   node tools/theme/clean-frames.js <theme-id> --force   # redo already-cleaned frames
 */
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { loadThemeConfig, themeDir, parseThemeIdFromArgs } = require('./lib');

// Euclidean RGB distance² threshold for "this is background". A pixel counts
// as background if it's within DIST of pure white AND connected to the border.
// 50 is permissive enough to capture JPEG-ish compression artefacts without
// eating into saturated character fills.
const DIST = 50;
const DIST2 = DIST * DIST;

function isBg(data, idx, channels) {
  const o = idx * channels;
  const dr = 255 - data[o];
  const dg = 255 - data[o + 1];
  const db = 255 - data[o + 2];
  return dr * dr + dg * dg + db * db < DIST2;
}

async function cleanFrame(filePath) {
  const { data, info } = await sharp(filePath)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { width: w, height: h, channels: c } = info;

  // Short-circuit: if all four corners are already transparent, assume already cleaned.
  const cornerIdx = [0, w - 1, (h - 1) * w, (h - 1) * w + (w - 1)];
  const cornersAlreadyClear = cornerIdx.every(i => data[i * c + 3] < 10);
  if (cornersAlreadyClear) return { skipped: true };

  const visited = new Uint8Array(w * h);
  const stack = [];

  // Seed from every border pixel that looks like background.
  for (let x = 0; x < w; x++) {
    const top = x;
    const bot = (h - 1) * w + x;
    if (isBg(data, top, c)) stack.push(top);
    if (isBg(data, bot, c)) stack.push(bot);
  }
  for (let y = 0; y < h; y++) {
    const left = y * w;
    const right = y * w + (w - 1);
    if (isBg(data, left, c)) stack.push(left);
    if (isBg(data, right, c)) stack.push(right);
  }

  // 4-way flood. Uses a flat stack instead of recursion so big frames don't
  // blow the call stack.
  while (stack.length) {
    const i = stack.pop();
    if (visited[i]) continue;
    if (!isBg(data, i, c)) continue;
    visited[i] = 1;
    const x = i % w;
    const y = (i - x) / w;
    if (x > 0) stack.push(i - 1);
    if (x < w - 1) stack.push(i + 1);
    if (y > 0) stack.push(i - w);
    if (y < h - 1) stack.push(i + w);
  }

  // Apply: visited pixels get alpha=0. Also soften 1px edge for anti-alias:
  // pixels adjacent to a visited pixel that are near-white get partial alpha.
  let cleared = 0;
  for (let i = 0; i < w * h; i++) {
    if (visited[i]) {
      data[i * c + 3] = 0;
      cleared++;
    }
  }

  await sharp(data, { raw: { width: w, height: h, channels: c } })
    .png()
    .toFile(filePath);

  return { cleared, total: w * h };
}

function* iterFrames(themeId, config) {
  for (const char of config.characters) {
    const animDir = path.join(themeDir(themeId), 'chars', char.id, 'anim');
    const walkDir = path.join(themeDir(themeId), 'chars', char.id, 'walk');
    const portraitDir = path.join(themeDir(themeId), 'chars', char.id, 'portrait');
    for (const dir of [animDir, walkDir, portraitDir]) {
      if (!fs.existsSync(dir)) continue;
      for (const f of fs.readdirSync(dir)) {
        if (f.endsWith('.png')) yield { label: path.relative(themeDir(themeId), path.join(dir, f)), file: path.join(dir, f) };
      }
    }
  }
  const enemiesRoot = path.join(themeDir(themeId), 'enemies');
  if (fs.existsSync(enemiesRoot)) {
    for (const type of fs.readdirSync(enemiesRoot)) {
      const d = path.join(enemiesRoot, type);
      if (!fs.statSync(d).isDirectory()) continue;
      for (const f of fs.readdirSync(d)) {
        if (f.endsWith('.png')) yield { label: path.relative(themeDir(themeId), path.join(d, f)), file: path.join(d, f) };
      }
    }
  }
  for (const boss of config.bosses) {
    const d = path.join(themeDir(themeId), 'bosses', boss.id);
    if (!fs.existsSync(d)) continue;
    for (const f of fs.readdirSync(d)) {
      if (f.endsWith('.png')) yield { label: path.relative(themeDir(themeId), path.join(d, f)), file: path.join(d, f) };
    }
  }
}

async function main() {
  const themeId = parseThemeIdFromArgs(process.argv);
  const config = loadThemeConfig(themeId);
  console.log(`[clean-frames] theme=${themeId}`);

  let cleaned = 0, skipped = 0, failed = 0;
  for (const entry of iterFrames(themeId, config)) {
    try {
      const r = await cleanFrame(entry.file);
      if (r.skipped) { skipped++; }
      else { cleaned++; }
    } catch (e) {
      console.warn(`  FAIL ${entry.label}: ${e.message}`);
      failed++;
    }
  }
  console.log(`[clean-frames] done. cleaned=${cleaned}  already-clean=${skipped}  failed=${failed}`);
  if (failed > 0) process.exit(2);
}

if (require.main === module) {
  main().catch(e => { console.error('[clean-frames] FAILED:', e.message); process.exit(1); });
}

module.exports = { main, cleanFrame };
