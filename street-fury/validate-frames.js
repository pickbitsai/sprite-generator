/**
 * Stage 5.5: Per-frame validator.
 * Runs after characters/enemies/bosses and before assemble. Checks each
 * generated frame PNG for the qualities assemble.js + regridSheet() assume:
 *
 *   1. File exists (every frame declared in characters.js ANIM_FRAMES /
 *      assemble.js ENEMY_LAYOUT / BOSS_LAYOUT is present on disk).
 *   2. Transparent corners — baked-in white/coloured backgrounds break the
 *      alpha-based row detection in src/sprites.js:regridSheet and collapse
 *      multi-row sheets into one row. All four corners must have alpha < 30.
 *   3. Non-empty content — the frame must have a non-trivial opaque bounding
 *      box (at least `minContentArea` px² of alpha > 30).
 *   4. Single dominant blob — frames with two disjoint opaque regions (the
 *      "two figures per cell" bug) are rejected. We take the biggest
 *      connected component and require it to cover >= 70% of the total
 *      non-transparent area.
 *   5. Roughly centered — content bbox centroid within the middle 60% of the
 *      frame (otherwise the sprite will land off-center inside its grid cell).
 *
 * Usage:
 *   node tools/theme/validate-frames.js <theme-id>
 *   node tools/theme/validate-frames.js <theme-id> --fix   # delete failing
 *                                                          # frames so a
 *                                                          # rerun of
 *                                                          # characters.js
 *                                                          # regenerates them
 *
 * Exit code: 0 = all frames pass, 2 = one or more failed.
 */
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { loadThemeConfig, themeDir, parseThemeIdFromArgs } = require('./lib');
const { ANIM_FRAMES, WALK_POSES } = require('./characters');
const { ENEMY_LAYOUT, ENEMY_ROW_ORDER, BOSS_LAYOUT } = require('./assemble');

// Tunables.
const CORNER_MARGIN = 8;        // pixels inset for corner sampling
const CORNER_ALPHA_MAX = 30;    // fail if any corner alpha exceeds this
const CONTENT_ALPHA_MIN = 30;   // pixels above this count as "content"
const MIN_CONTENT_FRACTION = 0.02; // >= 2% of pixels must be content
const DOMINANT_BLOB_MIN = 0.70; // biggest blob >= 70% of content
const CENTER_WINDOW = 0.60;     // centroid must be within middle 60% × 60%

async function loadAlphaGrid(filePath) {
  const { data, info } = await sharp(filePath)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { width: w, height: h, channels } = info;
  const alpha = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    alpha[i] = data[i * channels + (channels - 1)];
  }
  return { alpha, w, h };
}

// Count connected components of alpha > threshold and return (size of largest,
// total content pixel count, centroid of all content). Uses iterative 4-way
// flood fill so big images don't blow the stack.
function analyzeContent({ alpha, w, h }) {
  const visited = new Uint8Array(w * h);
  let totalContent = 0;
  let cx = 0, cy = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (alpha[y * w + x] > CONTENT_ALPHA_MIN) {
        totalContent++;
        cx += x;
        cy += y;
      }
    }
  }
  if (totalContent === 0) return { totalContent: 0, biggestBlob: 0, centroidX: 0.5, centroidY: 0.5 };

  let biggest = 0;
  const stack = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (visited[i] || alpha[i] <= CONTENT_ALPHA_MIN) continue;
      stack.length = 0;
      stack.push(i);
      visited[i] = 1;
      let size = 0;
      while (stack.length) {
        const p = stack.pop();
        size++;
        const px = p % w, py = (p - px) / w;
        if (px > 0) { const q = p - 1; if (!visited[q] && alpha[q] > CONTENT_ALPHA_MIN) { visited[q] = 1; stack.push(q); } }
        if (px < w - 1) { const q = p + 1; if (!visited[q] && alpha[q] > CONTENT_ALPHA_MIN) { visited[q] = 1; stack.push(q); } }
        if (py > 0) { const q = p - w; if (!visited[q] && alpha[q] > CONTENT_ALPHA_MIN) { visited[q] = 1; stack.push(q); } }
        if (py < h - 1) { const q = p + w; if (!visited[q] && alpha[q] > CONTENT_ALPHA_MIN) { visited[q] = 1; stack.push(q); } }
      }
      if (size > biggest) biggest = size;
    }
  }

  return {
    totalContent,
    biggestBlob: biggest,
    centroidX: (cx / totalContent) / w,
    centroidY: (cy / totalContent) / h,
  };
}

function cornerAlpha({ alpha, w, h }) {
  const m = Math.min(CORNER_MARGIN, Math.floor(Math.min(w, h) / 8));
  const pts = [[m, m], [w - 1 - m, m], [m, h - 1 - m], [w - 1 - m, h - 1 - m]];
  return pts.map(([x, y]) => alpha[y * w + x]);
}

async function validateFrame(filePath) {
  if (!fs.existsSync(filePath)) {
    return { ok: false, reason: 'missing' };
  }
  let grid;
  try {
    grid = await loadAlphaGrid(filePath);
  } catch (e) {
    return { ok: false, reason: 'unreadable: ' + e.message };
  }
  const { w, h } = grid;

  const corners = cornerAlpha(grid);
  const maxCorner = Math.max(...corners);
  if (maxCorner > CORNER_ALPHA_MAX) {
    return { ok: false, reason: `opaque background (max corner alpha ${maxCorner})`, corners };
  }

  const { totalContent, biggestBlob, centroidX, centroidY } = analyzeContent(grid);
  const contentFrac = totalContent / (w * h);
  if (contentFrac < MIN_CONTENT_FRACTION) {
    return { ok: false, reason: `near-empty frame (content ${(contentFrac * 100).toFixed(2)}% of pixels)` };
  }
  const dominantFrac = biggestBlob / totalContent;
  if (dominantFrac < DOMINANT_BLOB_MIN) {
    return { ok: false, reason: `fragmented content (biggest blob is ${(dominantFrac * 100).toFixed(1)}% of total — likely two figures or stray artefacts)` };
  }
  const halfWin = CENTER_WINDOW / 2;
  if (centroidX < 0.5 - halfWin || centroidX > 0.5 + halfWin ||
      centroidY < 0.5 - halfWin || centroidY > 0.5 + halfWin) {
    return { ok: false, reason: `off-center (centroid ${centroidX.toFixed(2)},${centroidY.toFixed(2)})` };
  }

  return { ok: true, w, h };
}

function charFramePaths(themeId, char) {
  const animDir = path.join(themeDir(themeId), 'chars', char.id, 'anim');
  const walkDir = path.join(themeDir(themeId), 'chars', char.id, 'walk');
  const paths = [];
  for (const pose of WALK_POSES) {
    paths.push({ label: `chars/${char.id}/walk/${pose.name}`, file: path.join(walkDir, `${pose.name}.png`) });
  }
  for (const anim of ANIM_FRAMES) {
    for (let i = 1; i <= anim.count; i++) {
      paths.push({ label: `chars/${char.id}/anim/${anim.key}_${i}`, file: path.join(animDir, `${anim.key}_${i}.png`) });
    }
  }
  // Walk frames are mirrored into anim/walk_N.png by characters.js; validate those too.
  for (let i = 1; i <= WALK_POSES.length; i++) {
    paths.push({ label: `chars/${char.id}/anim/walk_${i}`, file: path.join(animDir, `walk_${i}.png`) });
  }
  return paths;
}

function enemyFramePaths(themeId) {
  const paths = [];
  for (const type of ENEMY_ROW_ORDER) {
    const dir = path.join(themeDir(themeId), 'enemies', type);
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      if (f.endsWith('.png')) {
        paths.push({ label: `enemies/${type}/${f}`, file: path.join(dir, f) });
      }
    }
  }
  return paths;
}

function bossFramePaths(themeId, bosses) {
  const paths = [];
  for (const boss of bosses) {
    const dir = path.join(themeDir(themeId), 'bosses', boss.id);
    if (!fs.existsSync(dir)) continue;
    for (const [animKey, spec] of Object.entries(BOSS_LAYOUT)) {
      for (let i = 1; i <= spec.count; i++) {
        paths.push({ label: `bosses/${boss.id}/${animKey}_${i}`, file: path.join(dir, `${animKey}_${i}.png`) });
      }
    }
  }
  return paths;
}

async function main() {
  const themeId = parseThemeIdFromArgs(process.argv);
  const fix = process.argv.includes('--fix');
  const config = loadThemeConfig(themeId);

  console.log(`[validate-frames] theme=${themeId}${fix ? '  mode=--fix (will delete failing frames)' : ''}`);

  const all = [];
  for (const char of config.characters) all.push(...charFramePaths(themeId, char));
  all.push(...enemyFramePaths(themeId));
  all.push(...bossFramePaths(themeId, config.bosses));

  let ok = 0, fail = 0, deleted = 0;
  const failures = [];

  for (const entry of all) {
    const r = await validateFrame(entry.file);
    if (r.ok) { ok++; continue; }
    fail++;
    failures.push({ ...entry, reason: r.reason });
    if (fix && r.reason !== 'missing' && fs.existsSync(entry.file)) {
      fs.unlinkSync(entry.file);
      deleted++;
    }
  }

  console.log(`[validate-frames] checked ${all.length}  ok=${ok}  fail=${fail}${fix ? `  deleted=${deleted}` : ''}`);

  if (failures.length) {
    console.log(`[validate-frames] failures (first 40 of ${failures.length}):`);
    for (const f of failures.slice(0, 40)) {
      console.log(`  ${f.label}: ${f.reason}`);
    }
    if (failures.length > 40) console.log(`  ...and ${failures.length - 40} more`);
  }

  if (fail > 0) {
    if (fix) {
      console.log(`[validate-frames] deleted ${deleted} bad frames — rerun characters.js / enemies.js / bosses.js to regenerate.`);
    } else {
      console.log(`[validate-frames] rerun with --fix to delete failing frames so the next generator pass regenerates them.`);
    }
    process.exit(2);
  }

  console.log(`[validate-frames] PASSED.`);
}

if (require.main === module) {
  main().catch(e => { console.error('[validate-frames] FAILED:', e.message); process.exit(1); });
}

module.exports = { main, validateFrame };
