/**
 * Stage 2.5: Character references.
 *
 * Generates ONE canonical reference image per character, enemy type, and
 * boss. Every downstream pose is produced by IMAGE-EDITING this reference
 * ("same character, now doing X") instead of calling text-to-image again
 * and getting a different interpretation of the prompt. Reference images
 * are the source of truth for character identity — everything gated on
 * consistency compares against them.
 *
 * Usage:
 *   node tools/theme/references.js <theme-id> [--force]
 * Output:
 *   src/themes/<id>/chars/<charId>/reference.png
 *   src/themes/<id>/enemies/<type>/reference.png
 *   src/themes/<id>/bosses/<bossId>/reference.png
 */
const fs = require('fs');
const path = require('path');
const { loadApiKey, loadThemeConfig, themeAssetDir, generateWithRetry, SPRITE_STYLE, parseThemeIdFromArgs, sleep } = require('./lib');

function referencePrompt(desc, role) {
  return [
    SPRITE_STYLE,
    `Character: ${desc}`,
    role ? `Role: ${role}.` : '',
    'Pose: CANONICAL REFERENCE pose — standing upright at rest, neutral confident stance, facing three-quarter-right, arms relaxed. This will be the reference that every animation frame is matched against, so the character must be clearly readable: every identifying feature visible, no motion blur, no dramatic angle.',
    'Proportions, palette, outfit, and silhouette MUST be reproducible — whoever edits this later will need enough detail to re-render the same character in any pose.',
  ].filter(Boolean).join('\n');
}

async function main() {
  const themeId = parseThemeIdFromArgs(process.argv);
  const force = process.argv.includes('--force');
  const config = loadThemeConfig(themeId);
  const apiKey = loadApiKey();

  console.log(`[references] theme=${themeId}`);

  let ok = 0, skipped = 0, failed = 0;

  for (const char of config.characters) {
    const dir = themeAssetDir(themeId, `chars/${char.id}`);
    const out = path.join(dir, 'reference.png');
    process.stdout.write(`  char ${char.id}... `);
    const r = await generateWithRetry(apiKey, referencePrompt(char.visualDesc, char.role), out, { force });
    if (r.skipped) { console.log('skipped'); skipped++; }
    else if (r.ok) { console.log('OK'); ok++; }
    else { console.log('FAIL: ' + r.err); failed++; }
    await sleep(400);
  }

  for (const [typeKey, enemy] of Object.entries(config.enemies)) {
    const dir = themeAssetDir(themeId, `enemies/${typeKey}`);
    const out = path.join(dir, 'reference.png');
    process.stdout.write(`  enemy ${typeKey}... `);
    const r = await generateWithRetry(apiKey, referencePrompt(enemy.visualDesc, `${typeKey} enemy (${enemy.name})`), out, { force });
    if (r.skipped) { console.log('skipped'); skipped++; }
    else if (r.ok) { console.log('OK'); ok++; }
    else { console.log('FAIL: ' + r.err); failed++; }
    await sleep(400);
  }

  for (const boss of config.bosses) {
    const dir = themeAssetDir(themeId, `bosses/${boss.id}`);
    const out = path.join(dir, 'reference.png');
    process.stdout.write(`  boss ${boss.id}... `);
    const r = await generateWithRetry(apiKey, referencePrompt(boss.visualDesc, `boss (${boss.name})`), out, { force });
    if (r.skipped) { console.log('skipped'); skipped++; }
    else if (r.ok) { console.log('OK'); ok++; }
    else { console.log('FAIL: ' + r.err); failed++; }
    await sleep(400);
  }

  console.log(`[references] done. ok=${ok} skipped=${skipped} failed=${failed}`);
  if (failed > 0) process.exit(2);
}

if (require.main === module) {
  main().catch(e => { console.error('[references] FAILED:', e.message); process.exit(1); });
}

module.exports = { main, referencePrompt };
