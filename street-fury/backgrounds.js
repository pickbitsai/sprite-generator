/**
 * Stage 2: Background art.
 * Generates ONE 16:9 "level scene" per level (sky → skyline → street,
 * top-to-bottom) and slices it into three parallax layer files with sharp.
 * Previously this stage made 9 separate API calls (3 levels × bg/mid/ground);
 * the one-call-per-level approach guarantees the three layers share a palette
 * and gives us a consistent look per level at 1/3 the cost.
 *
 * Usage:  node tools/theme/backgrounds.js <theme-id> [--force]
 * Output:
 *   src/themes/<theme-id>/bg/level<N>-scene.png   (source reference)
 *   src/themes/<theme-id>/bg/level<N>-bg.png      (upper band — sky + far)
 *   src/themes/<theme-id>/bg/level<N>-mid.png     (middle band — buildings)
 *   src/themes/<theme-id>/bg/level<N>-ground.png  (lower band — street)
 */
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { loadApiKey, loadThemeConfig, themeAssetDir, generateWithRetry, BG_STYLE, parseThemeIdFromArgs, sleep } = require('./lib');

// Target output size matches what the renderer (src/renderer.js) assumes for
// background layers: 1536×1024 per layer image, horizontal composition.
const LAYER_W = 1536;
const LAYER_H = 1024;

// Three overlapping bands we carve from each 1536×1024 scene image. Each is
// fed through sharp.extract() then stretched to fill 1536×1024 so the current
// renderer crops (hardcoded in renderer.js) still land on the right content.
// top/height are normalized 0..1 of the source image height.
const BANDS = [
  { key: 'bg',     top: 0.00, height: 0.60 },   // sky + distant skyline
  { key: 'mid',    top: 0.25, height: 0.50 },   // mid-ground buildings
  { key: 'ground', top: 0.55, height: 0.45 },   // street / ground plane
];

// Stronger no-people language — Imagen and gpt-image-1 both tend to bleed
// characters into theme backgrounds otherwise. Repeat the constraint in
// different phrasings; that's measurably more effective than one strict line.
const NO_PEOPLE = [
  'EMPTY SCENE with absolutely NO people, NO humans, NO characters, NO figures, NO silhouettes, NO crowds.',
  'Abandoned, uninhabited, nobody visible anywhere in the frame.',
  'Do not draw any character from the source franchise — background environments only.',
].join(' ');

function buildScenePrompt(config, level) {
  const bg = level.bgDesc || level.environment;
  const mid = level.midDesc || level.environment;
  const ground = level.groundDesc || level.environment;
  return [
    BG_STYLE,
    NO_PEOPLE,
    `Theme: ${config.title} — ${config.prompt || config.id}.`,
    `Level: ${level.name}. Environment: ${level.environment}.`,
    'Wide 16:9 landscape composition stratified top-to-bottom so it can be used as stacked parallax layers:',
    `  - Top band (sky / far distance): ${bg}`,
    `  - Middle band (mid-ground structures): ${mid}`,
    `  - Bottom band (ground plane / street surface): ${ground}`,
    'Each band should be internally consistent in palette and lighting so they read as one scene.',
    'Leave a clear ground line near the bottom. No HUD, no text, no logos, no watermarks.',
  ].join('\n');
}

async function sliceLayers(scenePath, outDir, levelNumber, force) {
  const meta = await sharp(scenePath).metadata();
  const W = meta.width, H = meta.height;
  const results = [];
  for (const band of BANDS) {
    const outPath = path.join(outDir, `level${levelNumber}-${band.key}.png`);
    if (fs.existsSync(outPath) && !force) {
      results.push({ key: band.key, skipped: true });
      continue;
    }
    const top = Math.round(H * band.top);
    const height = Math.round(H * band.height);
    await sharp(scenePath)
      .extract({ left: 0, top, width: W, height })
      .resize(LAYER_W, LAYER_H, { fit: 'fill' })
      .png()
      .toFile(outPath);
    results.push({ key: band.key, outPath });
  }
  return results;
}

async function main() {
  const themeId = parseThemeIdFromArgs(process.argv);
  const force = process.argv.includes('--force');
  const config = loadThemeConfig(themeId);
  const apiKey = loadApiKey();
  const outDir = themeAssetDir(themeId, 'bg');

  console.log(`[backgrounds] theme=${themeId}  levels=${config.levels.length}  mode=scene-slice`);

  let scenesOk = 0, scenesSkipped = 0, scenesFailed = 0;
  for (let i = 0; i < config.levels.length; i++) {
    const level = config.levels[i];
    const levelNumber = i + 1;
    const scenePath = path.join(outDir, `level${levelNumber}-scene.png`);

    console.log(`  level ${levelNumber}: ${level.name}`);
    process.stdout.write('    scene... ');

    const prompt = buildScenePrompt(config, level);
    const r = await generateWithRetry(apiKey, prompt, scenePath, { aspectRatio: '16:9', force });

    if (r.skipped) { console.log('skipped (exists)'); scenesSkipped++; }
    else if (r.ok) { console.log('OK'); scenesOk++; }
    else { console.log('FAIL: ' + r.err); scenesFailed++; continue; }

    // Slice regardless of whether we just generated or already had the scene —
    // ensures layer files exist even if an earlier run bailed after the call.
    try {
      const slices = await sliceLayers(scenePath, outDir, levelNumber, force);
      const summary = slices.map(s => s.skipped ? `${s.key}:skip` : `${s.key}:OK`).join(' ');
      console.log(`    slice → ${summary}`);
    } catch (e) {
      console.log(`    slice FAIL: ${e.message}`);
      scenesFailed++;
    }

    await sleep(500);
  }

  console.log(`[backgrounds] done. scenes ok=${scenesOk} skipped=${scenesSkipped} failed=${scenesFailed}`);
  if (scenesFailed > 0) process.exit(2);
}

if (require.main === module) {
  main().catch(e => { console.error('[backgrounds] FAILED:', e.message); process.exit(1); });
}

module.exports = { main };
