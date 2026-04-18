/**
 * Stage 4b: Boss sprites.
 * Generates the 3 themed bosses with animation frames. Uses image-edit
 * against bosses/<id>/reference.png when available (produced by
 * references.js) so every pose is the same boss in a different stance,
 * not a fresh roll of the character.
 *
 * Usage:  node tools/theme/bosses.js <theme-id>
 * Output: src/themes/<theme-id>/bosses/<bossId>/<anim>_<N>.png
 */
const fs = require('fs');
const path = require('path');
const { loadApiKey, loadThemeConfig, themeAssetDir, themeDir, generateWithRetry, editWithRetry, SPRITE_STYLE, parseThemeIdFromArgs, sleep } = require('./lib');

const BOSS_ANIMS = [
  { key: 'idle',     count: 3, desc: 'intimidating idle pose, heavy breathing' },
  { key: 'walk',     count: 4, desc: 'walking towards the player' },
  { key: 'attack1',  count: 4, desc: 'signature melee attack' },
  { key: 'attack2',  count: 4, desc: 'second attack pattern (heavier or ranged)' },
  { key: 'special',  count: 5, desc: 'devastating special move with big windup and impact' },
  { key: 'hurt',     count: 2, desc: 'staggering back after taking damage' },
  { key: 'dead',     count: 1, desc: 'defeated, collapsed' },
];

function editPoseInstruction(poseDesc) {
  return [
    'Redraw THE EXACT SAME BOSS CHARACTER from the reference image in a new pose.',
    'Preserve identity rigorously: same face, same outfit, same palette, same body proportions, same line style.',
    `New pose: ${poseDesc}.`,
    '16-bit retro arcade beat-em-up boss sprite, side-view profile facing right, plain white or transparent background, NO shadow, NO ground line, NO text, NO other characters. Imposing full-body silhouette, centered.',
  ].join(' ');
}

async function main() {
  const themeId = parseThemeIdFromArgs(process.argv);
  const config = loadThemeConfig(themeId);
  const apiKey = loadApiKey();

  let ok = 0, skipped = 0, failed = 0;
  for (const boss of config.bosses) {
    console.log(`\n[bosses] === ${boss.name} (${boss.id}) ===`);
    const bossDir = themeAssetDir(themeId, `bosses/${boss.id}`);
    const refPath = path.join(bossDir, 'reference.png');
    const useReference = fs.existsSync(refPath);
    if (!useReference) console.log('  [warn] no reference.png — identity will drift. Run references.js first.');

    for (const anim of BOSS_ANIMS) {
      for (let f = 0; f < anim.count; f++) {
        const poseDesc = `${anim.key} frame ${f + 1}/${anim.count} — ${anim.desc}`;
        const out = path.join(bossDir, `${anim.key}_${f + 1}.png`);
        process.stdout.write(`  ${anim.key} ${f + 1}... `);
        let r;
        if (useReference) {
          r = await editWithRetry(apiKey, refPath, editPoseInstruction(poseDesc), out);
        } else {
          const prompt = `${SPRITE_STYLE}\nBoss character: ${boss.visualDesc}\nRole: powerful imposing boss, bigger and more detailed than regular enemies.\nAnimation: ${poseDesc}.\nConsistent proportions across all frames.`;
          r = await generateWithRetry(apiKey, prompt, out);
        }
        if (r.skipped) { console.log('skipped'); skipped++; }
        else if (r.ok) { console.log('OK'); ok++; }
        else { console.log('FAIL: ' + r.err); failed++; }
      }
    }
    await sleep(500);
  }
  console.log(`\n[bosses] done. ok=${ok} skipped=${skipped} failed=${failed}`);
  if (failed > 0) process.exit(2);
}

if (require.main === module) {
  main().catch(e => { console.error('[bosses] FAILED:', e.message); process.exit(1); });
}

module.exports = { main, BOSS_ANIMS };
