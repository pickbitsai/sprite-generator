/**
 * Stage 5: Sprite sheet assembly.
 * Uses sharp to composite individual generated frames into the grid-based
 * sprite sheets the engine expects. All themed sheets use a uniform
 * 8-col × N-row layout with 256×256 cells.
 *
 * Usage:  node tools/theme/assemble.js <theme-id>
 * Output: src/themes/<theme-id>/assembled/*.png
 */
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { loadThemeConfig, themeAssetDir, themeDir, parseThemeIdFromArgs } = require('./lib');

const CELL = 256;
const SHEET_COLS = 8;

// Unified layout for themed characters. MUST mirror REX_ANIMS in src/sprites.js
// exactly — themed chars fall through to REX_ANIMS at runtime (player.js:392),
// so any deviation means the game reads wrong cells (e.g., playing 'jump'
// pulled 'attack2' frames before this was aligned).
const CHAR_LAYOUT = {
  idle:       { row: 0, startCol: 0, count: 4 },
  // Walk row holds the 2-frame cycle; the engine loops 1-2-1-2. Runtime
  // still draws from row 0 cols 4-7 via REX_ANIMS but we only populate
  // cols 4-5 (lift/plant). Cols 6-7 stay empty by design.
  walk:       { row: 0, startCol: 4, count: 2 },
  attack1:    { row: 1, startCol: 0, count: 3 },
  attack2:    { row: 1, startCol: 3, count: 3 },
  attack3:    { row: 1, startCol: 6, count: 2 },
  jump:       { row: 2, startCol: 0, count: 2 },
  jumpAttack: { row: 2, startCol: 2, count: 2 },
  // 'special' in REX_ANIMS overlaps jump/jumpAttack (row 2, cols 0-5).
  // We don't generate dedicated special frames, so we let the special
  // animation reuse whatever's already in row 2. No separate placement.
  hurt:       { row: 3, startCol: 0, count: 2 },
  knockdown:  { row: 3, startCol: 2, count: 2 },
  dead:       { row: 4, startCol: 0, count: 1 },
};

// Themed enemy layout. MUST mirror ENEMY_ANIMS in src/sprites.js exactly —
// the engine reads hurt/knockdown/dead from col 5; placing them at col 7
// (as an earlier version did) meant getting hit caused enemies to render
// from an empty cell or from stale attack-frame content. The 2-frame-walk
// fix for player chars applies here too: use col 0 for idle/walk/cooldown,
// col 4 for telegraph/attack, col 5 for hurt/knockdown/dead. Only one
// attack frame is authoritative for the engine; we ALSO place frames
// 2-3 of attack at cols 5-6 but the engine ignores them (col 5 read by
// hurt wins because we write hurt LAST and the composite respects order).
const ENEMY_LAYOUT = {
  idle:      { startCol: 0, count: 2 },
  walk:      { startCol: 0, count: 4 },
  approach:  { startCol: 0, count: 4 },
  telegraph: { startCol: 4, count: 1 },
  attack:    { startCol: 4, count: 1 },
  cooldown:  { startCol: 0, count: 2 },
  hurt:      { startCol: 5, count: 1 },
  knockdown: { startCol: 5, count: 1 },
  dead:      { startCol: 7, count: 1 },
};

const ENEMY_ROW_ORDER = ['basic', 'rusher', 'blocker', 'thrower', 'heavy'];

// Unified layout for themed bosses (per-boss sheet, 8 cols).
const BOSS_LAYOUT = {
  idle:    { row: 0, startCol: 0, count: 3 },
  walk:    { row: 0, startCol: 3, count: 4 },
  attack1: { row: 1, startCol: 0, count: 4 },
  attack2: { row: 1, startCol: 4, count: 4 },
  special: { row: 2, startCol: 0, count: 5 },
  hurt:    { row: 3, startCol: 0, count: 2 },
  dead:    { row: 3, startCol: 2, count: 1 },
};

// Pack a source frame into a CELL×CELL slot with ~10% margin on every side
// so sprites never touch cell boundaries. Two reasons:
//   1) prevents heads/feet from bleeding into the adjacent cell when the
//      engine crops by pixel-exact source rects,
//   2) leaves visual breathing room so on-screen enemies don't look jammed
//      against their own hitbox edges.
// The content is first tight-cropped to its own alpha bounding box (so
// empty source padding doesn't eat into the usable area), then resized
// into the inner region, then centered inside the full CELL with
// transparent extension.
const CELL_MARGIN_PX = Math.round(CELL * 0.10);  // ~26px on a 256 cell
const INNER = CELL - 2 * CELL_MARGIN_PX;
async function resizeToCell(srcPath) {
  // Tight-crop around actual opaque content so whatever padding the source
  // came with doesn't shrink the character inside the inner box.
  const trimmed = await sharp(srcPath).ensureAlpha().trim({ threshold: 10 }).toBuffer().catch(() => null);
  const base = trimmed || (await sharp(srcPath).toBuffer());
  return sharp(base)
    .resize(INNER, INNER, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .extend({
      top: CELL_MARGIN_PX,
      bottom: CELL_MARGIN_PX,
      left: CELL_MARGIN_PX,
      right: CELL_MARGIN_PX,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .png()
    .toBuffer();
}

async function assembleSheet(cells, rows, cols) {
  const width = CELL * cols;
  const height = CELL * rows;
  const composite = [];
  for (const c of cells) {
    composite.push({ input: c.buf, top: c.row * CELL, left: c.col * CELL });
  }
  return sharp({
    create: { width, height, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 0 } },
  }).composite(composite).png().toBuffer();
}

async function assembleCharacterSheet(themeId, charId) {
  const animDir = path.join(themeDir(themeId), 'chars', charId, 'anim');
  const cells = [];
  let maxRow = 0;
  for (const [animKey, spec] of Object.entries(CHAR_LAYOUT)) {
    for (let i = 0; i < spec.count; i++) {
      // For 'special' we reuse attack3 frames if no dedicated ones were generated.
      const primary = path.join(animDir, `${animKey}_${i + 1}.png`);
      let src = primary;
      if (!fs.existsSync(primary) && animKey === 'special') {
        src = path.join(animDir, `attack3_${i + 1}.png`);
      }
      if (!fs.existsSync(src)) continue;
      const buf = await resizeToCell(src);
      const col = spec.startCol + i;
      cells.push({ buf, row: spec.row, col });
      if (spec.row > maxRow) maxRow = spec.row;
    }
  }
  if (cells.length === 0) throw new Error(`No frames found for char ${charId}`);
  const sheet = await assembleSheet(cells, maxRow + 1, SHEET_COLS);
  const outPath = path.join(themeAssetDir(themeId, 'assembled'), `${charId}.png`);
  fs.writeFileSync(outPath, sheet);
  return outPath;
}

async function assembleWalkStrip(themeId, charId) {
  // Classic 2-frame walk cycle looped 1-2-1-2. From whatever walk PNGs exist
  // (new naming 1_lift/2_plant, or legacy 4-phase 1_left_up/2_left_down/
  // 3_right_up/4_right_down), pick the PAIR with the most distinct
  // silhouettes (lowest 64×64 alpha-IoU) and place it as cells 0 and 1. That
  // way generators that happen to produce 4 similar-looking phases still
  // yield the strongest 2-frame cycle the existing assets can give.
  const walkDir = path.join(themeDir(themeId), 'chars', charId, 'walk');
  if (!fs.existsSync(walkDir)) throw new Error(`No walk dir for ${charId}`);

  const candidateNames = ['1_lift', '2_plant', '1_left_up', '2_left_down', '3_right_up', '4_right_down'];
  const available = candidateNames
    .map(n => ({ name: n, file: path.join(walkDir, `${n}.png`) }))
    .filter(c => fs.existsSync(c.file));
  if (available.length < 2) throw new Error(`Need ≥ 2 walk frames for ${charId}, found ${available.length}`);

  // 64×64 silhouette per candidate.
  async function sig(p) {
    const { data, info } = await sharp(p).ensureAlpha()
      .resize(64, 64, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .raw().toBuffer({ resolveWithObject: true });
    const m = new Uint8Array(info.width * info.height);
    for (let i = 0; i < m.length; i++) m[i] = data[i * info.channels + (info.channels - 1)] > 100 ? 1 : 0;
    return m;
  }
  function iou(a, b) {
    let inter = 0, un = 0;
    for (let i = 0; i < a.length; i++) { if (a[i] || b[i]) un++; if (a[i] && b[i]) inter++; }
    return un ? inter / un : 0;
  }
  const sigs = await Promise.all(available.map(c => sig(c.file)));

  let bestI = 0, bestJ = 1, bestIoU = Infinity;
  for (let i = 0; i < available.length; i++) {
    for (let j = i + 1; j < available.length; j++) {
      const s = iou(sigs[i], sigs[j]);
      if (s < bestIoU) { bestIoU = s; bestI = i; bestJ = j; }
    }
  }
  const chosen = [available[bestI], available[bestJ]];
  // Deterministic ordering: smaller numeric prefix → cell 0 so the "earlier"
  // pose leads the cycle.
  chosen.sort((a, b) => a.name.localeCompare(b.name));

  const frames = [];
  for (let i = 0; i < chosen.length; i++) {
    const buf = await resizeToCell(chosen[i].file);
    frames.push({ buf, row: 0, col: i });
  }
  const sheet = await assembleSheet(frames, 1, chosen.length);
  const outPath = path.join(themeAssetDir(themeId, 'assembled'), `${charId}_walk.png`);
  fs.writeFileSync(outPath, sheet);
  return outPath;
}

async function assembleEnemySheet(themeId) {
  const cells = [];
  for (let r = 0; r < ENEMY_ROW_ORDER.length; r++) {
    const type = ENEMY_ROW_ORDER[r];
    const enemyDir = path.join(themeDir(themeId), 'enemies', type);
    if (!fs.existsSync(enemyDir)) continue;
    // Place frames to match ENEMY_ANIMS (engine-side) cell positions:
    //   idle        cols 0-1     (frames:2)
    //   walk        cols 0-3     (frames:4, overlaps idle)
    //   attack      col  4       (frames:1 in the engine)
    //   hurt/dead   col  5       (frames:1) — written LAST so it wins over
    //                             any overlap from attack frames we might
    //                             have placed at cols 5-6 previously.
    // Cols 6-7 stay empty; that's fine, nothing reads them.
    const idle = glob(enemyDir, 'idle_');
    const walk = glob(enemyDir, 'walk_');
    const attack = glob(enemyDir, 'attack_');
    const hurt = glob(enemyDir, 'hurt_');
    const dead = glob(enemyDir, 'dead_');
    const placements = [
      ...idle.slice(0, 2).map((f, i) => ({ f, col: i })),
      ...walk.slice(0, 4).map((f, i) => ({ f, col: i })),
      ...attack.slice(0, 1).map((f, i) => ({ f, col: 4 + i })),
      ...(hurt[0] || dead[0] ? [{ f: hurt[0] || dead[0], col: 5 }] : []),
    ];
    for (const p of placements) {
      const buf = await resizeToCell(p.f);
      cells.push({ buf, row: r, col: p.col });
    }
  }
  if (cells.length === 0) throw new Error('No enemy frames');
  const sheet = await assembleSheet(cells, ENEMY_ROW_ORDER.length, SHEET_COLS);
  const outPath = path.join(themeAssetDir(themeId, 'assembled'), `enemies.png`);
  fs.writeFileSync(outPath, sheet);
  return outPath;
}

async function assembleBossSheet(themeId, boss) {
  const bossDir = path.join(themeDir(themeId), 'bosses', boss.id);
  if (!fs.existsSync(bossDir)) throw new Error(`Missing boss dir: ${bossDir}`);
  const cells = [];
  let maxRow = 0;
  for (const [animKey, spec] of Object.entries(BOSS_LAYOUT)) {
    for (let i = 0; i < spec.count; i++) {
      const src = path.join(bossDir, `${animKey}_${i + 1}.png`);
      if (!fs.existsSync(src)) continue;
      const buf = await resizeToCell(src);
      cells.push({ buf, row: spec.row, col: spec.startCol + i });
      if (spec.row > maxRow) maxRow = spec.row;
    }
  }
  if (cells.length === 0) throw new Error(`No frames for boss ${boss.id}`);
  const sheet = await assembleSheet(cells, maxRow + 1, SHEET_COLS);
  const outPath = path.join(themeAssetDir(themeId, 'assembled'), `boss_${boss.id}.png`);
  fs.writeFileSync(outPath, sheet);
  return outPath;
}

async function assemblePortrait(themeId, charId) {
  const src = path.join(themeDir(themeId), 'chars', charId, 'portrait', 'portrait.png');
  if (!fs.existsSync(src)) return null;
  const out = path.join(themeAssetDir(themeId, 'assembled'), `portrait_${charId}.png`);
  // Just resize to a reasonable portrait size (256×256, engine can handle)
  await sharp(src).resize(256, 256, { fit: 'cover' }).png().toFile(out);
  return out;
}

function glob(dir, prefix) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(f => f.startsWith(prefix) && f.endsWith('.png'))
    .sort()
    .map(f => path.join(dir, f));
}

async function main() {
  const themeId = parseThemeIdFromArgs(process.argv);
  const config = loadThemeConfig(themeId);

  console.log(`[assemble] theme=${themeId}`);

  for (const char of config.characters) {
    console.log(`  character: ${char.id}`);
    try {
      const sheet = await assembleCharacterSheet(themeId, char.id);
      console.log(`    sheet → ${path.basename(sheet)}`);
    } catch (e) { console.log(`    sheet FAIL: ${e.message}`); }
    try {
      const walk = await assembleWalkStrip(themeId, char.id);
      console.log(`    walk  → ${path.basename(walk)}`);
    } catch (e) { console.log(`    walk  FAIL: ${e.message}`); }
    try {
      const p = await assemblePortrait(themeId, char.id);
      if (p) console.log(`    portrait → ${path.basename(p)}`);
    } catch (e) { console.log(`    portrait FAIL: ${e.message}`); }
  }

  try {
    const e = await assembleEnemySheet(themeId);
    console.log(`  enemies → ${path.basename(e)}`);
  } catch (e) { console.log(`  enemies FAIL: ${e.message}`); }

  for (const boss of config.bosses) {
    try {
      const b = await assembleBossSheet(themeId, boss);
      console.log(`  boss ${boss.id} → ${path.basename(b)}`);
    } catch (e) { console.log(`  boss ${boss.id} FAIL: ${e.message}`); }
  }

  console.log(`[assemble] done.`);
}

if (require.main === module) {
  main().catch(e => { console.error('[assemble] FAILED:', e.message); process.exit(1); });
}

module.exports = { main, CHAR_LAYOUT, ENEMY_LAYOUT, ENEMY_ROW_ORDER, BOSS_LAYOUT, CELL };
