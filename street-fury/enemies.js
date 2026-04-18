/**
 * Stage 4a: Enemy sprites.
 * Generates the 5 themed enemy types with animation frames matching the
 * existing enemy sheet layout (idle, walk, attack, hurt/dead).
 *
 * When enemies/<type>/reference.png exists (from references.js), every pose
 * is produced by image-editing that reference — same body, same palette,
 * only the pose changes. That's the lever for cross-frame consistency.
 * Falls back to text-to-image if no reference is available.
 *
 * Usage:  node tools/theme/enemies.js <theme-id>
 * Output: src/themes/<theme-id>/enemies/<type>/<anim>_<N>.png
 */
const fs = require('fs');
const path = require('path');
const { loadApiKey, loadThemeConfig, themeAssetDir, themeDir, generateWithRetry, editWithRetry, SPRITE_STYLE, parseThemeIdFromArgs, sleep } = require('./lib');

// Counts MUST match what assembleEnemySheet actually places. The assembler
// writes walk at cols 0-3 AFTER idle, so generated idle frames are always
// overwritten — not worth generating. Engine reads exactly one attack frame
// (col 4); dead shares col 5 with hurt (single frame reused). Total: 6
// generations per enemy type (down from 11).
const ENEMY_ANIMS = [
  { key: 'walk',   count: 4, desc: 'walking forward aggressively' },
  { key: 'attack', count: 1, desc: 'launching a strike or attack' },
  { key: 'hurt',   count: 1, desc: 'reeling back from being hit' },
];

function editPoseInstruction(poseDesc) {
  return [
    'Redraw THE EXACT SAME ENEMY from the reference image in a new pose.',
    'Preserve identity rigorously: same face, same outfit, same palette, same body proportions, same line style.',
    `New pose: ${poseDesc}.`,
    '16-bit retro arcade beat-em-up sprite, side-view profile facing right, plain white or transparent background, NO shadow, NO ground line, NO text, NO other characters. Full body visible, character centered.',
  ].join(' ');
}

async function main() {
  const themeId = parseThemeIdFromArgs(process.argv);
  const config = loadThemeConfig(themeId);
  const apiKey = loadApiKey();

  let ok = 0, skipped = 0, failed = 0;
  for (const [typeKey, enemy] of Object.entries(config.enemies)) {
    console.log(`\n[enemies] === ${typeKey}: ${enemy.name} ===`);
    const enemyDir = path.join(themeDir(themeId), 'enemies', typeKey);
    fs.mkdirSync(enemyDir, { recursive: true });
    const refPath = path.join(enemyDir, 'reference.png');
    const useReference = fs.existsSync(refPath);
    if (!useReference) console.log('  [warn] no reference.png — identity will drift. Run references.js first.');

    for (const anim of ENEMY_ANIMS) {
      for (let f = 0; f < anim.count; f++) {
        const poseDesc = `${anim.key} frame ${f + 1}/${anim.count} — ${anim.desc}`;
        const out = path.join(enemyDir, `${anim.key}_${f + 1}.png`);
        process.stdout.write(`  ${anim.key} ${f + 1}... `);
        let r;
        if (useReference) {
          r = await editWithRetry(apiKey, refPath, editPoseInstruction(poseDesc), out);
        } else {
          const prompt = `${SPRITE_STYLE}\nEnemy character: ${enemy.visualDesc}\nRole: ${typeKey} enemy (${enemy.name}).\nAnimation: ${poseDesc}.\nConsistent proportions across frames.`;
          r = await generateWithRetry(apiKey, prompt, out);
        }
        if (r.skipped) { console.log('skipped'); skipped++; }
        else if (r.ok) { console.log('OK'); ok++; }
        else { console.log('FAIL: ' + r.err); failed++; }
      }
    }
    await sleep(500);
  }
  console.log(`\n[enemies] done. ok=${ok} skipped=${skipped} failed=${failed}`);
  if (failed > 0) process.exit(2);
}

if (require.main === module) {
  main().catch(e => { console.error('[enemies] FAILED:', e.message); process.exit(1); });
}

module.exports = { main, ENEMY_ANIMS };
