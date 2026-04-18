/**
 * Stage 8.5: Sheet layout verification.
 *
 * The engine reads sprites via hardcoded ANIMS maps in src/sprites.js
 * (REX_ANIMS, ENEMY_ANIMS, BOSS1_ANIMS, BOSS2_ANIMS, BOSS3_P1_ANIMS,
 * BOSS3_P2_ANIMS). Themed chars fall through to REX_ANIMS at runtime
 * (player.js:~392). If the assembler lays frames out at different rows/cols
 * than what the ANIMS map says, the engine reads empty cells and the
 * animation silently renders nothing — no console error, no visible crash,
 * just a disappearing sprite. This stage catches that statically: for each
 * assembled sheet + expected ANIMS map, confirm every (row, col) in the
 * map has non-trivial opaque content.
 *
 * Exit code: 0 if all animations have content in the right cells, 2 otherwise.
 */
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { loadThemeConfig, themeDir, parseThemeIdFromArgs } = require('./lib');
const { CELL } = require('./assemble');

// Hardcoded copies of the ANIMS maps in src/sprites.js. They MUST track the
// engine; if sprites.js changes, this file needs updating too.
// Note: `walk` on themed characters uses a 2-frame cycle (lift/plant) — see
// tools/theme/characters.js WALK_POSES + build-config.js emitting
// window.THEME.walkFrames = 2. Base game still uses 4-5 frame strips, but
// this validator is themed-only so it checks for the 2-frame count.
const REX_ANIMS = {
  idle:       { row: 0, startCol: 0, frames: 4 },
  walk:       { row: 0, startCol: 4, frames: 2 },
  attack1:    { row: 1, startCol: 0, frames: 3 },
  attack2:    { row: 1, startCol: 3, frames: 3 },
  attack3:    { row: 1, startCol: 6, frames: 2 },
  jump:       { row: 2, startCol: 0, frames: 2 },
  jumpAttack: { row: 2, startCol: 2, frames: 2 },
  hurt:       { row: 3, startCol: 0, frames: 2 },
  knockdown:  { row: 3, startCol: 2, frames: 2 },
  dead:       { row: 4, startCol: 0, frames: 1 }, // themed dead has 1 frame; engine value is 5 but extras repeat-render fine
};
const ENEMY_ANIMS_PER_ROW = {
  idle:      { startCol: 0, frames: 2 },
  walk:      { startCol: 0, frames: 4 },
  approach:  { startCol: 0, frames: 4 },
  attack:    { startCol: 4, frames: 1 },
  hurt:      { startCol: 5, frames: 1 },
};
const ENEMY_ROW_ORDER = ['basic', 'rusher', 'blocker', 'thrower', 'heavy'];
// Bosses use varied ANIMS maps; themed sheets follow the assembler's
// BOSS_LAYOUT which matches ONLY the shared "idle / walk / attack1 / hurt"
// subset. Verify that subset.
const BOSS_CHECK_ANIMS = {
  idle:    { row: 0, startCol: 0, frames: 3 },
  walk:    { row: 0, startCol: 3, frames: 2 },
  attack:  { row: 1, startCol: 3, frames: 3 },
  hurt:    { row: 3, startCol: 0, frames: 2 },
};

const CELL_CONTENT_MIN_PX = 200; // px of alpha > 30 needed to count as "has content"

async function loadAlphaGrid(filePath) {
  const { data, info } = await sharp(filePath)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height, channels: info.channels };
}

function cellHasContent(grid, sheetCellW, sheetCellH, row, col) {
  const { data, width, channels } = grid;
  const x0 = col * sheetCellW;
  const y0 = row * sheetCellH;
  const x1 = Math.min(x0 + sheetCellW, grid.width);
  const y1 = Math.min(y0 + sheetCellH, grid.height);
  if (x0 >= grid.width || y0 >= grid.height) return false;
  let opaque = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const a = data[(y * width + x) * channels + (channels - 1)];
      if (a > 30) {
        opaque++;
        if (opaque >= CELL_CONTENT_MIN_PX) return true;
      }
    }
  }
  return false;
}

async function verifySheet(label, filePath, checks, sheetCellW = CELL, sheetCellH = CELL) {
  if (!fs.existsSync(filePath)) return [{ label, ok: false, reason: 'sheet missing' }];
  const grid = await loadAlphaGrid(filePath);
  const rows = Math.round(grid.height / sheetCellH);
  const cols = Math.round(grid.width / sheetCellW);
  const results = [];
  for (const chk of checks) {
    const missing = [];
    for (let i = 0; i < chk.frames; i++) {
      const col = chk.startCol + i;
      if (chk.row >= rows || col >= cols) {
        missing.push(`r${chk.row}c${col} (out of bounds; sheet ${rows}×${cols})`);
        continue;
      }
      if (!cellHasContent(grid, sheetCellW, sheetCellH, chk.row, col)) {
        missing.push(`r${chk.row}c${col}`);
      }
    }
    if (missing.length) {
      results.push({ label, anim: chk.anim, ok: false, reason: `empty cells: ${missing.join(', ')}` });
    } else {
      results.push({ label, anim: chk.anim, ok: true });
    }
  }
  return results;
}

function charChecks() {
  return Object.entries(REX_ANIMS).map(([anim, spec]) => ({ anim, ...spec }));
}

function enemyChecks() {
  // Row 0..4 per enemy type, but the ANIMS map has no row field — the engine
  // adds `row: ENEMY_ROW[type]` at draw time. Check every row × the shared
  // subset of animations.
  const out = [];
  for (let r = 0; r < ENEMY_ROW_ORDER.length; r++) {
    for (const [anim, spec] of Object.entries(ENEMY_ANIMS_PER_ROW)) {
      out.push({ anim: `${ENEMY_ROW_ORDER[r]}/${anim}`, row: r, startCol: spec.startCol, frames: spec.frames });
    }
  }
  return out;
}

function bossChecks() {
  return Object.entries(BOSS_CHECK_ANIMS).map(([anim, spec]) => ({ anim, ...spec }));
}

async function main() {
  const themeId = parseThemeIdFromArgs(process.argv);
  const config = loadThemeConfig(themeId);
  const assembledDir = path.join(themeDir(themeId), 'assembled');

  console.log(`[verify-layout] theme=${themeId}`);

  const allResults = [];

  for (const char of config.characters) {
    const sheet = path.join(assembledDir, `${char.id}.png`);
    const r = await verifySheet(`char/${char.id}`, sheet, charChecks());
    allResults.push(...r);
  }

  const enemies = path.join(assembledDir, 'enemies.png');
  allResults.push(...await verifySheet('enemies', enemies, enemyChecks()));

  for (const boss of config.bosses) {
    const sheet = path.join(assembledDir, `boss_${boss.id}.png`);
    allResults.push(...await verifySheet(`boss/${boss.id}`, sheet, bossChecks()));
  }

  const failures = allResults.filter(r => !r.ok);
  console.log(`[verify-layout] checks=${allResults.length}  ok=${allResults.length - failures.length}  fail=${failures.length}`);

  if (failures.length) {
    for (const f of failures) {
      console.log(`  ${f.label} / ${f.anim || '?'}: ${f.reason}`);
    }
    console.log(`[verify-layout] FAILED — the engine will render empty cells for the animations above.`);
    console.log(`[verify-layout] Most common cause: tools/theme/assemble.js CHAR_LAYOUT / BOSS_LAYOUT doesn't match the ANIMS maps in src/sprites.js.`);
    process.exit(2);
  }

  console.log(`[verify-layout] PASSED.`);
}

if (require.main === module) {
  main().catch(e => { console.error('[verify-layout] FAILED:', e.message); process.exit(1); });
}

module.exports = { main, verifySheet, charChecks, enemyChecks, bossChecks };
