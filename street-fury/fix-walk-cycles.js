/**
 * Fix broken walk cycles in-place using ComfyUI img2img + IP-Adapter + OpenPose.
 *
 * For each character in the theme:
 *   For each of the 4 walk frames (1_left_up, 2_left_down, 3_right_up, 4_right_down):
 *     - init image  = existing frame (preserves most pixels)
 *     - reference   = reference.png if it exists, else the existing frame
 *     - pose image  = corresponding walk_N.png skeleton
 *   → output overwrites the existing frame + the mirrored anim/walk_N.png.
 *
 * Usage:
 *   node tools/theme/fix-walk-cycles.js <theme-id>
 *   node tools/theme/fix-walk-cycles.js <theme-id> --char homer_simpson
 *
 * ComfyUI must be running (`tools/theme/check-comfyui.js` returns READY)
 * and OpenPose ControlNet SDXL (control-lora-openposeXL2-rank256.safetensors)
 * must be in models/controlnet/.
 */
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { loadThemeConfig, themeDir, callComfyUI, parseThemeIdFromArgs } = require('./lib');

const WORKFLOW = path.join(__dirname, 'comfyui', 'workflow-fix-walk.json');
const POSES_DIR = path.join(__dirname, 'comfyui', 'poses');
// Classic 2-frame walk cycle. The engine loops these 1-2-1-2 (see
// player.js walkFrames handling + build-config.js THEME.walkFrames).
const WALK_FRAMES = [
  { name: '1_lift',  pose: 'walk_1.png', desc: 'mid-stride LIFT pose: front leg bent at knee and raised up high, trailing leg straight and supporting full body weight, arms swung wide in opposite directions for counterbalance' },
  { name: '2_plant', pose: 'walk_2.png', desc: 'PLANT pose: front leg planted forward carrying weight with knee slightly bent, trailing leg lifting up behind with foot angled up and back, arms tighter to body mid-swing' },
];

async function resizeToSquare(filePath, size) {
  return sharp(filePath)
    .resize(size, size, { fit: 'contain', background: { r: 255, g: 255, b: 255, alpha: 0 } })
    .png()
    .toBuffer();
}

async function fixOneFrame(themeId, char, frame) {
  const walkDir = path.join(themeDir(themeId), 'chars', char.id, 'walk');
  const animDir = path.join(themeDir(themeId), 'chars', char.id, 'anim');
  const framePath = path.join(walkDir, `${frame.name}.png`);
  const refPath = path.join(themeDir(themeId), 'chars', char.id, 'reference.png');
  const posePath = path.join(POSES_DIR, frame.pose);

  if (!fs.existsSync(framePath)) return { ok: false, reason: 'missing walk frame' };
  if (!fs.existsSync(posePath)) return { ok: false, reason: 'missing pose skeleton' };

  // Render at 768×768 — fits comfortably inside 12 GB VRAM with IP-Adapter +
  // ControlNet + img2img all loaded, whereas 1024×1024 pushes us into swap
  // and kills throughput (~30 s/frame → >4 min/frame on a 3080 Ti).
  const RENDER_SIZE = 768;
  const initBuf = await resizeToSquare(framePath, RENDER_SIZE);
  const refSource = fs.existsSync(refPath) ? refPath : framePath;
  const refBuf = await resizeToSquare(refSource, RENDER_SIZE);
  // Skeletons are authored at 1024×1024; downsample so ControlNet receives a
  // resolution compatible with the latent from our 768×768 init.
  const poseRawBuf = fs.readFileSync(posePath);
  const poseBuf = await sharp(poseRawBuf).resize(RENDER_SIZE, RENDER_SIZE, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 255 } }).png().toBuffer();

  const prompt = `16-bit retro arcade beat-em-up pixel sprite, the SAME character as the reference image, side-view facing right, ${frame.desc}, plain white background, full body visible, clean outline, vibrant colors, no other characters, no text`;

  const resultBuf = await callComfyUI(
    { REF_IMAGE: refBuf, INIT_IMAGE: initBuf, POSE_IMAGE: poseBuf },
    prompt,
    { workflowPath: WORKFLOW, timeoutMs: 600000 }
  );

  // Save back at the same size as the existing frame so nothing downstream breaks.
  const origMeta = await sharp(framePath).metadata();
  const targetW = origMeta.width || 1024;
  const targetH = origMeta.height || 1024;
  await sharp(resultBuf).resize(targetW, targetH, { fit: 'contain', background: { r: 255, g: 255, b: 255, alpha: 0 } }).png().toFile(framePath);

  // The assembler reads anim/walk_N.png for the in-sheet walk row; keep in sync.
  const frameIndex = WALK_FRAMES.findIndex(f => f.name === frame.name);
  const animOut = path.join(animDir, `walk_${frameIndex + 1}.png`);
  fs.copyFileSync(framePath, animOut);

  return { ok: true };
}

async function main() {
  const themeId = parseThemeIdFromArgs(process.argv);
  const only = (() => {
    const i = process.argv.indexOf('--char');
    return i > 0 ? process.argv[i + 1] : null;
  })();
  const config = loadThemeConfig(themeId);

  console.log(`[fix-walk-cycles] theme=${themeId}${only ? `  char=${only}` : ''}`);

  const chars = only ? config.characters.filter(c => c.id === only) : config.characters;
  if (only && chars.length === 0) throw new Error(`unknown char ${only}`);

  let ok = 0, fail = 0;
  for (const char of chars) {
    console.log(`\n[fix-walk-cycles] === ${char.id} ===`);
    for (const frame of WALK_FRAMES) {
      process.stdout.write(`  ${frame.name}... `);
      const t0 = Date.now();
      try {
        const r = await fixOneFrame(themeId, char, frame);
        if (r.ok) { console.log(`OK (${((Date.now() - t0) / 1000).toFixed(1)}s)`); ok++; }
        else { console.log(`SKIP: ${r.reason}`); }
      } catch (e) {
        console.log(`FAIL: ${e.message}`);
        fail++;
      }
    }
  }
  console.log(`\n[fix-walk-cycles] done. ok=${ok} fail=${fail}`);
  if (fail > 0) process.exit(2);
  console.log('[fix-walk-cycles] Next: node tools/theme/verify-walk-cycle.js', themeId);
}

if (require.main === module) {
  main().catch(e => { console.error('[fix-walk-cycles] CRASHED:', e.message); process.exit(1); });
}

module.exports = { main, fixOneFrame, WALK_FRAMES };
