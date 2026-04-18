/**
 * Stage 3: Character sprites.
 * For each of the 4 themed characters: walk cycle (6 poses) + full anim sheet
 * frames (idle, walk, attack1-3, jump, jumpAttack, hurt, knockdown, dead) +
 * portrait.
 *
 * Usage:  node tools/theme/characters.js <theme-id> [character-index]
 * Output: src/themes/<theme-id>/chars/<charId>/{walk,anim,portrait}/...
 */
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { loadApiKey, loadThemeConfig, themeAssetDir, themeDir, generateWithRetry, editWithRetry, SPRITE_STYLE, parseThemeIdFromArgs, sleep } = require('./lib');

// Identity-locked edit prompt. The goal is "same character, same outfit, same
// palette, same silhouette proportions — change ONLY the pose." This is the
// single biggest lever for cross-frame consistency; phrased too loosely, the
// edit model redraws the character.
function editPoseInstruction(poseDesc) {
  return [
    'Redraw THE EXACT SAME CHARACTER from the reference image in a new pose.',
    'Preserve identity rigorously: same face, same hairstyle, same outfit, same palette, same body proportions, same line style.',
    `New pose: ${poseDesc}.`,
    '16-bit retro arcade beat-em-up sprite, side-view profile facing right, plain transparent or pure white background, NO shadow, NO ground line, NO text, NO other characters. Full body visible head to feet. Character centered, filling ~80% of vertical space.',
  ].join(' ');
}

// 2-frame walk cycle — classic Streets of Rage / Final Fight convention.
// Pure side-view can't reliably distinguish anatomical left vs right legs
// (both occupy the same vertical axis), so instead of pretending to do
// 4-phase alternation we use the two silhouettes that ACTUALLY differ:
// "lift" (one leg raised mid-stride, knee bent) and "plant" (leading leg
// planted, trailing leg pushing off). The engine loops these 1-2-1-2.
const WALK_POSES = [
  { name: '1_lift',  pose: 'mid-stride with the leading leg lifted forward, knee bent, trailing leg straight back supporting the body, arms swinging opposite to legs' },
  { name: '2_plant', pose: 'leading leg planted forward with knee slightly bent, trailing leg pushed off behind with foot starting to lift, body at lowest point of stride, arms mid-swing' },
];

// Counts MUST match CHAR_LAYOUT in tools/theme/assemble.js — anything extra
// is a generation the assembler silently discards. Genre reference: SoR1-era
// beat-em-ups use ~20-23 unique poses per character; we match that exactly.
const ANIM_FRAMES = [
  { key: 'idle',        row: 0, count: 4, desc: 'standing idle fighting stance, slight bob between frames' },
  { key: 'attack1',     row: 2, count: 3, desc: 'throwing a quick jab/punch forward' },
  { key: 'attack2',     row: 3, count: 3, desc: 'follow-up strike, different arm' },
  { key: 'attack3',     row: 4, count: 2, desc: 'strong finishing attack, wide swing' },
  { key: 'jump',        row: 5, count: 2, desc: 'airborne jumping pose, legs tucked' },
  { key: 'jumpAttack',  row: 6, count: 2, desc: 'attacking while airborne' },
  { key: 'hurt',        row: 7, count: 2, desc: 'reeling back from being hit' },
  { key: 'knockdown',   row: 8, count: 2, desc: 'falling backwards, knocked off feet' },
  { key: 'dead',        row: 9, count: 1, desc: 'lying unconscious on the ground' },
];

async function generateCharacter(apiKey, themeId, char) {
  console.log(`\n[chars] === ${char.name} (${char.role}) ===`);
  const charRoot = path.join(themeDir(themeId), 'chars', char.id);
  const walkDir = path.join(charRoot, 'walk');
  const animDir = path.join(charRoot, 'anim');
  const portraitDir = path.join(charRoot, 'portrait');
  fs.mkdirSync(walkDir, { recursive: true });
  fs.mkdirSync(animDir, { recursive: true });
  fs.mkdirSync(portraitDir, { recursive: true });

  const charDesc = char.visualDesc;
  const refPath = path.join(charRoot, 'reference.png');
  const useReference = fs.existsSync(refPath);
  if (!useReference) {
    console.log('  [warn] no reference.png — falling back to text-to-image (character identity will drift between frames). Run references.js first for consistency.');
  }

  let ok = 0, skipped = 0, failed = 0;

  // Generate a pose from the character reference image.
  // refOverride lets callers chain from a different source (e.g. idle_1 →
  // idle_2-4) so related frames share the same base appearance.
  async function generatePose(poseDesc, outPath, opts, refOverride) {
    const ref = refOverride || refPath;
    if (useReference || refOverride) {
      return editWithRetry(apiKey, ref, editPoseInstruction(poseDesc), outPath, opts);
    }
    const prompt = `${SPRITE_STYLE}\nCharacter: ${charDesc}\nPose: ${poseDesc}. Keep consistent proportions across all frames.`;
    return generateWithRetry(apiKey, prompt, outPath, opts);
  }

  // 1. Walk cycle — 2 poses, mirrored into anim/ so the assembler finds them under walk_N.png.
  console.log(`  [walk] ${WALK_POSES.length} poses`);
  for (let i = 0; i < WALK_POSES.length; i++) {
    const pose = WALK_POSES[i];
    const walkOut = path.join(walkDir, `${pose.name}.png`);
    const animOut = path.join(animDir, `walk_${i + 1}.png`);
    process.stdout.write(`    walk ${i + 1}/${WALK_POSES.length}... `);
    const r = await generatePose(pose.pose, walkOut);
    if (r.skipped) { console.log('skipped'); skipped++; }
    else if (r.ok) { console.log('OK'); ok++; }
    else { console.log('FAIL: ' + r.err); failed++; continue; }
    if (fs.existsSync(walkOut)) fs.copyFileSync(walkOut, animOut);
  }

  // 2. Full animation frames
  // Idle: generate 1 AI frame, then create 3 programmatic variants via pixel
  // shifts (breathing bob). This guarantees zero identity drift — the same
  // approach 16-bit beat-em-ups used. The engine cycles through 4 frames at
  // animSpeed 0.15, so the subtle 1-2px shifts produce a natural idle bob.
  // Offsets: [0, -2, 0, +1] px vertical shift for a breathe-in/breathe-out feel.
  const IDLE_BOB_OFFSETS = [0, -2, 0, 1];

  for (const anim of ANIM_FRAMES) {
    console.log(`  [${anim.key}] ${anim.count} frames`);

    if (anim.key === 'idle') {
      const idle1Path = path.join(animDir, 'idle_1.png');
      process.stdout.write(`    idle 1/${anim.count} (AI generate)... `);
      const r1 = await generatePose('standing idle fighting stance, weight centered, fists raised guard position', idle1Path);
      if (r1.skipped) { console.log('skipped'); skipped++; }
      else if (r1.ok) { console.log('OK'); ok++; }
      else { console.log('FAIL: ' + r1.err); failed++; }

      // Programmatic variants — shift idle_1 by a few pixels for breathing bob
      if (fs.existsSync(idle1Path)) {
        const srcBuf = fs.readFileSync(idle1Path);
        const meta = await sharp(srcBuf).metadata();
        for (let f = 1; f < anim.count; f++) {
          const out = path.join(animDir, `idle_${f + 1}.png`);
          if (fs.existsSync(out) && !r1.ok) { skipped++; continue; } // don't overwrite if idle_1 was skipped
          const dy = IDLE_BOB_OFFSETS[f] || 0;
          const shifted = await sharp({
            create: { width: meta.width, height: meta.height, channels: 4,
                      background: { r: 0, g: 0, b: 0, alpha: 0 } }
          }).composite([{ input: srcBuf, top: dy, left: 0 }]).png().toBuffer();
          fs.writeFileSync(out, shifted);
          process.stdout.write(`    idle ${f + 1}/${anim.count} (shift ${dy > 0 ? '+' : ''}${dy}px)... OK\n`);
          ok++;
        }
      }
      continue;
    }

    for (let f = 0; f < anim.count; f++) {
      const out = path.join(animDir, `${anim.key}_${f + 1}.png`);
      process.stdout.write(`    ${anim.key} ${f + 1}/${anim.count}... `);
      const r = await generatePose(`${anim.key} frame ${f + 1}/${anim.count} — ${anim.desc}`, out);
      if (r.skipped) { console.log('skipped'); skipped++; }
      else if (r.ok) { console.log('OK'); ok++; }
      else { console.log('FAIL: ' + r.err); failed++; }
    }
  }

  // 3. Portrait — derived from the same reference when available so the face matches the body sprites.
  const portraitOut = path.join(portraitDir, 'portrait.png');
  process.stdout.write(`    portrait... `);
  let pr;
  if (useReference) {
    pr = await editWithRetry(apiKey, refPath, 'Redraw the same character as a close-up portrait card, head-and-shoulders only, facing camera with a neutral or determined expression. Preserve identity: same face, hair, outfit colors. 16-bit arcade select-screen portrait style. Plain dark background.', portraitOut);
  } else {
    const portraitPrompt = `16-bit retro arcade character portrait card, style of Streets of Rage select screen. Close-up on character head and shoulders, bold colors, clean outline, neutral or determined expression.
Character: ${char.portraitDesc || char.visualDesc}
Plain dark background.`;
    pr = await generateWithRetry(apiKey, portraitPrompt, portraitOut, { aspectRatio: '1:1' });
  }
  if (pr.skipped) { console.log('skipped'); skipped++; }
  else if (pr.ok) { console.log('OK'); ok++; }
  else { console.log('FAIL: ' + pr.err); failed++; }

  return { ok, skipped, failed };
}

async function main() {
  const themeId = parseThemeIdFromArgs(process.argv);
  const charIndex = process.argv[3] ? parseInt(process.argv[3], 10) : null;
  const config = loadThemeConfig(themeId);
  const apiKey = loadApiKey();

  const totals = { ok: 0, skipped: 0, failed: 0 };
  const chars = charIndex !== null ? [config.characters[charIndex]] : config.characters;
  for (const char of chars) {
    const r = await generateCharacter(apiKey, themeId, char);
    totals.ok += r.ok; totals.skipped += r.skipped; totals.failed += r.failed;
    await sleep(800);
  }
  console.log(`\n[chars] done. ok=${totals.ok} skipped=${totals.skipped} failed=${totals.failed}`);
  if (totals.failed > 0) process.exit(2);
}

if (require.main === module) {
  main().catch(e => { console.error('[chars] FAILED:', e.message); process.exit(1); });
}

module.exports = { main, ANIM_FRAMES, WALK_POSES };
