/**
 * Stage 8.7: Walk cycle frame distinctness.
 *
 * Street Fury themed characters use a classic 2-frame walk cycle (lift /
 * plant), same convention as Streets of Rage / Final Fight. In pure
 * side-view the "anatomical left vs right leg forward" distinction isn't
 * reliably recoverable from a 2D silhouette, so instead of checking for
 * mirror-symmetric pairs we check that the two frames have **visibly
 * different** silhouettes — i.e., the animation will read as motion and
 * not as "stuck on one pose."
 *
 * Metric:
 *   sig0, sig1 = 64×64 binary silhouettes of walk frames 1_lift and 2_plant
 *   iou(sig0, sig1) should be LESS THAN a threshold — lower = more
 *   different. Identical frames score ~1.0; visibly different strides
 *   usually score 0.65 or lower.
 *
 * Usage:
 *   node tools/theme/verify-walk-cycle.js <theme-id>
 *   node tools/theme/verify-walk-cycle.js <theme-id> --fix
 *
 * Exit 0 if each character's walk frames are sufficiently distinct, 2 otherwise.
 */
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { loadThemeConfig, themeDir, parseThemeIdFromArgs } = require('./lib');

// Adjacent walk frames must have silhouette IoU <= this to count as
// "visibly different." Tuned empirically: identical frames ~0.95+, real
// 2-frame cycles (lift vs plant) land ~0.50-0.70. Mid-stride styles where
// both frames show bent legs at similar heights (common in simpler cartoon
// art like Adventure Time) land around 0.80-0.88 while still reading as
// motion in-engine. 0.92 still catches the truly-identical-frames bug.
const MAX_ADJACENT_IOU = 0.92;

// Read the ASSEMBLED walk strip (assembled/<char>_walk.png) instead of
// individual frame PNGs. That way this check validates what the engine
// actually sees, not what's in the per-frame source directory — and works
// regardless of whether a theme uses the new (1_lift / 2_plant) or legacy
// (1_left_up / 2_left_down / ...) source naming.

async function silhouette(source) {
  // `source` may be a file path or a PNG Buffer.
  const { data, info } = await sharp(source)
    .ensureAlpha()
    .resize(64, 64, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .raw()
    .toBuffer({ resolveWithObject: true });
  const mask = new Uint8Array(info.width * info.height);
  for (let i = 0; i < mask.length; i++) {
    mask[i] = data[i * info.channels + (info.channels - 1)] > 100 ? 1 : 0;
  }
  return { mask, w: info.width, h: info.height };
}

async function sliceCell(stripPath, col, cols) {
  const meta = await sharp(stripPath).metadata();
  const cellW = Math.floor(meta.width / cols);
  return sharp(stripPath)
    .extract({ left: col * cellW, top: 0, width: cellW, height: meta.height })
    .png()
    .toBuffer();
}

function iou(a, b) {
  let inter = 0, union = 0;
  for (let i = 0; i < a.mask.length; i++) {
    const ai = a.mask[i], bi = b.mask[i];
    if (ai || bi) union++;
    if (ai && bi) inter++;
  }
  return union ? inter / union : 0;
}

async function verifyCharWalk(themeId, char) {
  const stripPath = path.join(themeDir(themeId), 'assembled', `${char.id}_walk.png`);
  if (!fs.existsSync(stripPath)) {
    return [{ char: char.id, ok: false, reason: `missing assembled walk strip ${path.basename(stripPath)}` }];
  }
  const meta = await sharp(stripPath).metadata();
  const cellH = meta.height;
  const cols = Math.max(1, Math.round(meta.width / cellH)); // walk cells are square-ish (CELL × CELL)
  if (cols < 2) {
    return [{ char: char.id, ok: false, reason: `walk strip has only ${cols} cell(s); need ≥ 2` }];
  }
  // Compare cells 0 and 1 — the two frames the engine loops through when
  // walkFrames=2 (the themed default).
  const cell0 = await silhouette(await sliceCell(stripPath, 0, cols));
  const cell1 = await silhouette(await sliceCell(stripPath, 1, cols));
  const score = iou(cell0, cell1);
  const ok = score <= MAX_ADJACENT_IOU;
  return [{
    char: char.id,
    pair: `strip[0] vs strip[1]`,
    stripPath,
    ok,
    iou: score,
    reason: ok ? null : `silhouettes too similar (IoU ${score.toFixed(2)} > ${MAX_ADJACENT_IOU}) — frames will read as a single static pose`,
  }];
}

async function main() {
  const themeId = parseThemeIdFromArgs(process.argv);
  const fix = process.argv.includes('--fix');
  const config = loadThemeConfig(themeId);

  console.log(`[verify-walk-cycle] theme=${themeId}  maxAdjacentIoU=${MAX_ADJACENT_IOU}${fix ? '  mode=--fix' : ''}`);

  let ok = 0, fail = 0, deleted = 0;
  const failures = [];

  for (const char of config.characters) {
    const results = await verifyCharWalk(themeId, char);
    for (const r of results) {
      if (r.ok) { ok++; continue; }
      fail++;
      failures.push(r);
      if (fix) {
        // Nuke the assembled strip + mirrored anim copies + any walk/ source
        // PNGs so the next characters.js / assemble.js pass rebuilds them.
        const paths = [
          r.stripPath,
          ...Array.from({ length: 4 }, (_, i) => path.join(themeDir(themeId), 'chars', char.id, 'anim', `walk_${i + 1}.png`)),
          ...['1_lift', '2_plant', '1_left_up', '2_left_down', '3_right_up', '4_right_down']
            .map(n => path.join(themeDir(themeId), 'chars', char.id, 'walk', `${n}.png`)),
        ];
        for (const p of paths) { if (p && fs.existsSync(p)) { fs.unlinkSync(p); deleted++; } }
      }
    }
  }

  console.log(`[verify-walk-cycle] characters checked=${ok + fail}  ok=${ok}  fail=${fail}${fix ? `  deleted=${deleted}` : ''}`);

  if (failures.length) {
    for (const f of failures) {
      const label = f.pair || '?';
      console.log(`  ${f.char} / ${label}: ${f.reason || 'missing'}`);
    }
    if (!fix) console.log(`[verify-walk-cycle] rerun with --fix to delete broken walk frames so the next pass regenerates them.`);
    process.exit(2);
  }
  console.log(`[verify-walk-cycle] PASSED.`);
}

if (require.main === module) {
  main().catch(e => { console.error('[verify-walk-cycle] FAILED:', e.message); process.exit(1); });
}

module.exports = { main, verifyCharWalk, MAX_ADJACENT_IOU };
