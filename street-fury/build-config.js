/**
 * Stage 6: Build the theme.js file the engine loads.
 * Consumes the config.json (from concept) and assembled assets to produce a
 * single src/themes/<id>/theme.js that sets window.THEME = {...}.
 *
 * Usage:  node tools/theme/build-config.js <theme-id>
 * Output: src/themes/<theme-id>/theme.js
 */
const fs = require('fs');
const path = require('path');
const { loadThemeConfig, themeDir, parseThemeIdFromArgs } = require('./lib');
const { CHAR_LAYOUT, ENEMY_ROW_ORDER, CELL } = require('./assemble');

// Default wave/destructible/hazard data — structurally the same as the base
// levels.js; we only swap environment/names and the boss ID.
function defaultWaves() {
  return [
    { triggerX: 150, enemies: [{ type: 'basic', x: 420, y: 160 }, { type: 'basic', x: 450, y: 190 }] },
    { triggerX: 400, enemies: [{ type: 'basic', x: 500, y: 165 }, { type: 'basic', x: 520, y: 185 }, { type: 'basic', x: -30, y: 175, fromLeft: true }] },
    { triggerX: 700, enemies: [{ type: 'rusher', x: 850, y: 170 }, { type: 'basic', x: 830, y: 195 }, { type: 'basic', x: -30, y: 160, fromLeft: true }] },
    { triggerX: 1000, enemies: [{ type: 'blocker', x: 1100, y: 155 }, { type: 'basic', x: 1130, y: 180 }, { type: 'rusher', x: -30, y: 170, fromLeft: true }] },
    { triggerX: 1400, enemies: [{ type: 'thrower', x: 1550, y: 150 }, { type: 'basic', x: 1500, y: 180 }, { type: 'rusher', x: -30, y: 165, fromLeft: true }] },
    { triggerX: 1800, enemies: [{ type: 'heavy', x: 1900, y: 175 }, { type: 'basic', x: 1930, y: 155 }, { type: 'basic', x: 1950, y: 195 }] },
    { triggerX: 2200, enemies: [{ type: 'blocker', x: 2350, y: 160 }, { type: 'thrower', x: 2380, y: 195 }, { type: 'rusher', x: -30, y: 175, fromLeft: true }] },
  ];
}

function buildTheme(config, themeId) {
  const asset = (sub) => `src/themes/${themeId}/assembled/${sub}`;
  const bgAsset = (sub) => `src/themes/${themeId}/bg/${sub}`;

  // Sprite sources: mirror the existing loader keys, point at themed assets.
  const spriteSources = {};
  for (const c of config.characters) {
    spriteSources[c.spriteKey || c.id] = asset(`${c.id}.png`);
    spriteSources[`${c.spriteKey || c.id}Walk`] = asset(`${c.id}_walk.png`);
    spriteSources[`portrait${cap(c.id)}`] = asset(`portrait_${c.id}.png`);
  }
  spriteSources.enemies = asset('enemies.png');
  config.bosses.forEach((b, i) => {
    const key = ['streetBrawler', 'techBoss', 'finalBoss'][i];
    spriteSources[key] = asset(`boss_${b.id}.png`);
  });
  // Backgrounds
  const levelKeys = [
    ['l1Bg', 'l1Mid', 'l1Ground'],
    ['l2Bg', 'l2Mid', 'l2Ground'],
    ['l3Bg', 'l3Mid', 'l3Ground'],
  ];
  for (let i = 0; i < 3; i++) {
    spriteSources[levelKeys[i][0]] = bgAsset(`level${i + 1}-bg.png`);
    spriteSources[levelKeys[i][1]] = bgAsset(`level${i + 1}-mid.png`);
    spriteSources[levelKeys[i][2]] = bgAsset(`level${i + 1}-ground.png`);
  }
  // Keep the fallback effect sheets from the base game (not theme-specific).
  spriteSources.items         = 'src/items.png';
  spriteSources.projectiles   = 'src/projectile-sprites.png';
  spriteSources.hitImpact     = 'src/hit-impact-sprites.png';

  // CHARACTERS array for constants.js override
  const characters = config.characters.map((c) => ({
    name: c.name,
    type: c.role,
    color: c.color,
    outlineColor: c.outlineColor,
    speed: roleSpeed(c.role),
    power: rolePower(c.role),
    range: roleRange(c.role),
    maxHp: roleHp(c.role),
    description: c.visualDesc.slice(0, 60),
    stats: roleStats(c.role),
    spriteKey: c.spriteKey || c.id,
    spriteFrameW: CELL,
    spriteFrameH: CELL,
  }));

  // ENEMY_TYPES: keep the stat shape, swap names/colors
  const baseStats = {
    basic:   { hp: 20, speed: 1.2, damage: 6,  attackRange: 30,  score: 100, width: 20, height: 36 },
    rusher:  { hp: 15, speed: 3.5, damage: 8,  attackRange: 25,  score: 150, width: 18, height: 34 },
    blocker: { hp: 30, speed: 0.8, damage: 7,  attackRange: 28,  score: 200, width: 22, height: 38, canBlock: true },
    thrower: { hp: 15, speed: 1.0, damage: 5,  attackRange: 150, score: 150, width: 18, height: 34, isRanged: true, preferredDistance: 120 },
    heavy:   { hp: 50, speed: 0.6, damage: 12, attackRange: 35,  score: 250, width: 28, height: 42 },
  };
  const enemyTypes = {};
  for (const [k, stats] of Object.entries(baseStats)) {
    const e = config.enemies[k];
    enemyTypes[k] = {
      ...stats,
      name: e.name,
      color: e.color,
      outlineColor: e.outlineColor,
    };
  }

  // Boss defs: keyed by the engine's expected types street_brawler/tech_boss/final_boss
  const bossDefs = {};
  const engineBossKeys = ['street_brawler', 'tech_boss', 'final_boss'];
  config.bosses.forEach((b, i) => {
    bossDefs[engineBossKeys[i]] = {
      hp: b.stats?.hp ?? (200 + i * 50),
      speed: b.stats?.speed ?? 1.5,
      width: b.stats?.width ?? 30,
      height: b.stats?.height ?? 44,
      color: b.color,
      outlineColor: b.outlineColor,
      name: b.name,
    };
  });

  // Levels: reuse structural wave/destructible data from the base game; swap
  // name/subtitle/music/boss to match the theme.
  const levels = config.levels.map((l, i) => ({
    name: l.name,
    subtitle: l.subtitle,
    index: i,
    groundY: { min: 140, max: 210 },
    totalLength: 3000 + i * 200,
    music: `level${i + 1}`,
    bossMusic: `boss${i + 1}`,
    waves: [
      ...defaultWaves(),
      { triggerX: 2700 + i * 100, isBoss: true, boss: { type: engineBossKeys[i], x: 350, y: 175 } },
    ],
    destructibles: [
      { type: 'trashcan', x: 120, y: 195, drops: 'food_small' },
      { type: 'crate',    x: 550, y: 170, drops: 'food_small' },
      { type: 'barrel',   x: 900, y: 185, drops: 'food_large' },
      { type: 'trashcan', x: 1250, y: 160, drops: 'food_small' },
      { type: 'crate',    x: 1650, y: 190, drops: 'weapon_pipe' },
      { type: 'barrel',   x: 2050, y: 175, drops: 'food_large' },
      { type: 'crate',    x: 2500, y: 165, drops: 'food_small' },
    ],
    hazards: i > 0 ? [{ x: 480, y: 180 }, { x: 1150, y: 170 }, { x: 1920, y: 190 }] : [],
  }));

  const sceneKeys = [
    { bg: 'l1Bg', mid: 'l1Mid', ground: 'l1Ground' },
    { bg: 'l2Bg', mid: 'l2Mid', ground: 'l2Ground' },
    { bg: 'l3Bg', mid: 'l3Mid', ground: 'l3Ground' },
  ];

  // Regrid config: themed sheets come out of assemble.js on a clean CELL×CELL
  // grid, so preGridded: true makes the loader skip regridSheet — otherwise
  // rows with no transparent gap between them get merged into one blob.
  const regridConfig = {};
  const gridEntry = (minW) => ({ cellW: CELL, cellH: CELL, cols: 8, minW, preGridded: true });
  for (const c of config.characters) {
    regridConfig[c.spriteKey || c.id] = gridEntry(20);
  }
  regridConfig.enemies = gridEntry(20);
  regridConfig.streetBrawler = gridEntry(15);
  regridConfig.techBoss      = gridEntry(15);

  return {
    id: themeId,
    title: (config.title || themeId).toUpperCase(),
    // Themed walk strips are 2 frames (lift/plant) — see WALK_POSES in
    // tools/theme/characters.js and the engine's wrap logic in player.js.
    walkFrames: 2,
    // All themed sheets use the unified CELL×CELL grid from assemble.js.
    // Engine-side ENEMY_FRAME_W / BOSS*_FRAME_W constants are base-game
    // sizes and would read rows at the wrong offset if applied to themed
    // sheets (bleed between rows). enemy.js and boss.js prefer these.
    enemyFrameW: CELL,
    enemyFrameH: CELL,
    bossFrameW: CELL,
    bossFrameH: CELL,
    // Unified themed boss ANIMS. Base-game BOSS1_ANIMS / BOSS2_ANIMS /
    // BOSS3_P1/P2 use DIFFERENT row layouts (e.g. BOSS2 reads hurt from row
    // 4), but the themed assembler packs every boss on the same 4-row
    // BOSS_LAYOUT (idle row 0, attacks row 1, special row 2, hurt/dead row
    // 3). Boss.js overrides per-type animMap with this table when a theme
    // is loaded so all three boss slots read their expected cells.
    bossAnims: {
      idle:            { row: 0, startCol: 0, frames: 3 },
      intro:           { row: 0, startCol: 0, frames: 3 },
      walk:            { row: 0, startCol: 3, frames: 4 },
      approach:        { row: 0, startCol: 3, frames: 4 },
      recovery:        { row: 0, startCol: 0, frames: 2 },
      telegraph:       { row: 1, startCol: 0, frames: 2 },
      attack:          { row: 1, startCol: 0, frames: 4 },
      attack1:         { row: 1, startCol: 0, frames: 4 },
      attack2:         { row: 1, startCol: 4, frames: 4 },
      rangedAttack:    { row: 1, startCol: 4, frames: 4 },
      charge:          { row: 1, startCol: 0, frames: 4 },
      groundSlam:      { row: 1, startCol: 4, frames: 4 },
      beamAttack:      { row: 1, startCol: 4, frames: 4 },
      teleport:        { row: 2, startCol: 0, frames: 5 },
      special:         { row: 2, startCol: 0, frames: 5 },
      summon:          { row: 2, startCol: 0, frames: 5 },
      phaseTransition: { row: 2, startCol: 0, frames: 5 },
      hurt:            { row: 3, startCol: 0, frames: 2 },
      dead:            { row: 3, startCol: 2, frames: 1 },
    },
    subtitle: config.subtitle || '~ BEAT \'EM UP ~',
    titleColor: config.titleColor,
    titleShadow: config.titleShadow,
    subtitleColor: config.subtitleColor,
    palette: config.palette,
    characters,
    enemyTypes,
    bossDefs,
    levels,
    sceneKeys,
    spriteSources,
    regridConfig,
  };
}

function cap(s) { return s[0].toUpperCase() + s.slice(1); }

function roleSpeed(r)  { return { Brawler: 2.5, Speedster: 3.5, 'Martial-Artist': 3.0, Grappler: 2.0 }[r] || 2.5; }
function rolePower(r)  { return { Brawler: 1.4, Speedster: 0.8, 'Martial-Artist': 1.0, Grappler: 1.1 }[r] || 1.0; }
function roleRange(r)  { return { Brawler: 1.0, Speedster: 1.0, 'Martial-Artist': 1.0, Grappler: 1.5 }[r] || 1.0; }
function roleHp(r)     { return { Brawler: 120, Speedster: 80, 'Martial-Artist': 100, Grappler: 140 }[r] || 100; }
function roleStats(r)  {
  return { Brawler: { speed: 2, power: 3, range: 2 },
           Speedster: { speed: 3, power: 1, range: 2 },
           'Martial-Artist': { speed: 2, power: 2, range: 2 },
           Grappler: { speed: 1, power: 2, range: 3 } }[r] || { speed: 2, power: 2, range: 2 };
}

async function main() {
  const themeId = parseThemeIdFromArgs(process.argv);
  const config = loadThemeConfig(themeId);
  const theme = buildTheme(config, themeId);
  const outPath = path.join(themeDir(themeId), 'theme.js');
  const src = `// Auto-generated by tools/theme/build-config.js — do not edit by hand.
// Theme: ${themeId}  (${theme.title})
window.THEME = ${JSON.stringify(theme, null, 2)};
`;
  fs.writeFileSync(outPath, src);
  console.log(`[build-config] wrote ${outPath} (${src.length} bytes)`);
  console.log(`[build-config] load with: index.html?theme=${themeId}`);
}

if (require.main === module) {
  main().catch(e => { console.error('[build-config] FAILED:', e.message); process.exit(1); });
}

module.exports = { main, buildTheme };
