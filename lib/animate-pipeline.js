/**
 * Animation-first sprite generation.
 *
 * The other two generation modes (`generate`, `pack`) each produce STILLS —
 * independent poses, however consistent. Neither can produce real in-between
 * motion (a smear on a punch, the recovery frame of a death) because nothing
 * asked the model to animate anything; a human described a series of stills
 * and hoped they'd read as connected.
 *
 * This pipeline asks a video model to actually animate one seed image, then
 * harvests the frames you want out of the result. Identity drift is solved
 * by construction — every frame comes from the same continuous video of the
 * same character, so there is nothing to drift between. The only step that
 * can't be automated is picking which frames read as the poses you want;
 * that's a deliberate human checkpoint between `extract` and `sheet`, not a
 * missing feature.
 *
 * Four stages, each independently useful (see lib/animate-cli.js for the CLI):
 *   1. generateSeedFrame  — one still via gpt-image-1
 *   2. imageToVideo       — animate it via a Replicate image-to-video model
 *   3. extractFrames      — ffmpeg the clip into numbered PNGs (+ contact sheet)
 *   4. buildAnimationSheet — chroma-key + assemble your picks into a sheet
 */
import fs from 'fs';
import path from 'path';
import sharp from 'sharp';
import { execFileSync } from 'node:child_process';

// ---------------------------------------------------------------------------
// 1. Seed frame
// ---------------------------------------------------------------------------

/**
 * Generate one still via gpt-image-1 to seed the animation.
 *
 * Use `bg: 'magenta'` for the image you're about to animate — video models
 * animate a flat solid background far more reliably than a transparent one.
 * Use `bg: 'transparent'` only if you want a still sprite from the same
 * prompt, independent of the animation pipeline.
 *
 * Describe the MOTION you'll ask for later, not more of the character, here —
 * this frame only needs to nail identity once. The video step re-describes
 * motion, not appearance; naming/describing the character again at that step
 * invites drift (and can trip IP-moderation on recognizable designs).
 *
 * @param {object} opts
 * @param {import('openai').default} opts.openai
 * @param {string} opts.prompt   - full description of the character/subject
 * @param {'magenta'|'transparent'} [opts.bg]
 * @param {string} [opts.size]   - '1024x1024' | '1024x1536' | '1536x1024' | 'auto'
 * @returns {Buffer} PNG bytes
 */
export async function generateSeedFrame({ openai, prompt, bg = 'magenta', size = '1024x1024' }) {
  const bgClause = bg === 'transparent'
    ? 'The background is fully empty/transparent.'
    : 'Flat solid magenta background, RGB 255 0 255, evenly lit, absolutely no ground shadow, no gradient, no scenery.';
  const fullPrompt = `${prompt} ${bgClause} No text, no UI, no logos, no watermark, no signature.`;

  const response = await openai.images.generate({
    model: 'gpt-image-1',
    prompt: fullPrompt,
    n: 1,
    size,
    ...(bg === 'transparent' ? { background: 'transparent' } : {}),
  });
  const b64 = response.data[0].b64_json;
  if (!b64) throw new Error('No image bytes returned');
  return Buffer.from(b64, 'base64');
}

// ---------------------------------------------------------------------------
// 2. Image-to-video
// ---------------------------------------------------------------------------

/**
 * Animate a still via a Replicate image-to-video model. Submits a
 * prediction, polls to completion, returns the resulting clip's bytes.
 *
 * Prompt the MOTION, not the character — the seed image already carries
 * identity; describing the character again wastes tokens at best and invites
 * drift or a moderation block at worst.
 *
 * @param {object} opts
 * @param {string} opts.token         - REPLICATE_API_TOKEN
 * @param {Buffer} opts.imageBuf      - seed frame bytes (PNG)
 * @param {string} [opts.model]       - Replicate model, e.g. 'kwaivgi/kling-v2.1'
 * @param {string} [opts.imageField]  - the model's start-image input field name
 * @param {string} opts.prompt        - motion description
 * @param {string} [opts.negativePrompt]
 * @param {object} [opts.extra]       - extra model-specific input fields (duration, mode, ...)
 * @param {(status: string, elapsedSec: number) => void} [opts.onProgress]
 * @returns {Buffer} mp4 bytes
 */
export async function imageToVideo({
  token, imageBuf, model = 'kwaivgi/kling-v2.1', imageField = 'start_image',
  prompt, negativePrompt = '', extra = {}, onProgress,
}) {
  const dataUri = `data:image/png;base64,${imageBuf.toString('base64')}`;
  const input = {
    [imageField]: dataUri,
    prompt,
    ...(negativePrompt ? { negative_prompt: negativePrompt } : {}),
    ...extra,
  };

  let r = await fetch(`https://api.replicate.com/v1/models/${model}/predictions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ input }),
  });
  if (!r.ok) throw new Error(`Replicate submit failed: ${r.status} ${(await r.text()).slice(0, 600)}`);
  let pred = await r.json();

  const started = Date.now();
  while (['starting', 'processing'].includes(pred.status)) {
    await new Promise(res => setTimeout(res, 5000));
    r = await fetch(`https://api.replicate.com/v1/predictions/${pred.id}`, { headers: { Authorization: `Bearer ${token}` } });
    pred = await r.json();
    onProgress?.(pred.status, (Date.now() - started) / 1000);
  }
  if (pred.status !== 'succeeded') {
    throw new Error(`Replicate prediction ${pred.status}: ${JSON.stringify(pred.error).slice(0, 400)}`);
  }

  const url = Array.isArray(pred.output) ? pred.output[0] : pred.output;
  const dl = await fetch(url);
  return Buffer.from(await dl.arrayBuffer());
}

// ---------------------------------------------------------------------------
// 3. Frame extraction
// ---------------------------------------------------------------------------

/**
 * Explode a video clip into numbered frame PNGs, and optionally build a
 * contact sheet (every frame, tiled, with its number burned in) so a human
 * can pick which ones to keep. Requires `ffmpeg` on PATH.
 *
 * @param {object} opts
 * @param {string} opts.videoPath
 * @param {string} opts.outDir
 * @param {string} [opts.fps]       - empty/undefined = every frame the clip has
 * @param {boolean} [opts.contact]  - also write <outDir>/_contact.png
 * @param {number} [opts.cols]
 * @param {number} [opts.thumbWidth]
 * @returns {{ frameFiles: string[], contactPath: string|null }}
 */
export async function extractFrames({ videoPath, outDir, fps = '', contact = false, cols = 8, thumbWidth = 220 }) {
  fs.mkdirSync(outDir, { recursive: true });

  const args = ['-y', '-i', videoPath];
  if (fps) args.push('-vf', `fps=${fps}`);
  args.push(path.join(outDir, 'f_%03d.png'));
  try {
    execFileSync('ffmpeg', args, { stdio: ['ignore', 'ignore', 'inherit'] });
  } catch (err) {
    if (err.code === 'ENOENT') throw new Error('ffmpeg not found on PATH — install it (ffmpeg.org) and retry.');
    throw err;
  }

  const frameFiles = fs.readdirSync(outDir).filter(f => /^f_\d+\.png$/.test(f)).sort();
  if (!frameFiles.length) throw new Error(`ffmpeg produced no frames from ${videoPath}`);

  if (!contact) return { frameFiles, contactPath: null };

  const COLS = cols, TW = thumbWidth;
  const rows = Math.ceil(frameFiles.length / COLS);
  const first = await sharp(path.join(outDir, frameFiles[0])).metadata();
  const TH = Math.round((first.height / first.width) * TW);
  const LABEL = 22;
  const cellH = TH + LABEL;

  const composites = [];
  for (let i = 0; i < frameFiles.length; i++) {
    const n = frameFiles[i].match(/f_(\d+)\.png/)[1];
    const x = (i % COLS) * TW;
    const y = Math.floor(i / COLS) * cellH;
    composites.push({
      input: await sharp(path.join(outDir, frameFiles[i]))
        .resize(TW, TH, { fit: 'contain', background: { r: 20, g: 20, b: 26, alpha: 1 } })
        .png().toBuffer(),
      left: x, top: y,
    });
    composites.push({
      input: Buffer.from(
        `<svg width="${TW}" height="${LABEL}"><rect width="${TW}" height="${LABEL}" fill="#11131a"/>` +
        `<text x="6" y="16" font-family="monospace" font-size="14" fill="#7dd3fc">${n}</text></svg>`
      ),
      left: x, top: y + TH,
    });
  }

  const sheet = await sharp({
    create: { width: TW * COLS, height: cellH * rows, channels: 4, background: { r: 12, g: 12, b: 16, alpha: 1 } },
  }).composite(composites).png().toBuffer();

  const contactPath = path.join(outDir, '_contact.png');
  fs.writeFileSync(contactPath, sheet);
  return { frameFiles, contactPath };
}

// ---------------------------------------------------------------------------
// 4. Sheet assembly (chroma-key + despill + bottom-anchor)
// ---------------------------------------------------------------------------

async function keyFrame(file, bg, t0, t1, crop) {
  const [BR, BG, BB] = bg;
  let img = sharp(file);
  if (crop) img = img.extract({ left: crop[0], top: crop[1], width: crop[2], height: crop[3] });
  const { data, info } = await img.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width: W, height: H, channels: C } = info;
  for (let i = 0; i < data.length; i += C) {
    const r = data[i], g = data[i + 1], b = data[i + 2];
    const d = Math.hypot(r - BR, g - BG, b - BB);
    if (d < t0) { data[i + 3] = 0; continue; }
    if (d < t1) {
      data[i + 3] = Math.round(((d - t0) / (t1 - t0)) * 255);
      // Despill: chroma fringe skews toward the key color — pull the two
      // dominant key channels back toward the third to kill the color halo.
      if (r > g && b > g) { data[i] = Math.round((r + g) / 2); data[i + 2] = Math.round((b + g) / 2); }
    }
  }
  return sharp(data, { raw: { width: W, height: H, channels: C } }).png().toBuffer();
}

async function trimToAlphaBbox(buf) {
  const { data, info } = await sharp(buf).raw().toBuffer({ resolveWithObject: true });
  const { width: W, height: H, channels: C } = info;
  let minX = W, minY = H, maxX = 0, maxY = 0, any = false;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (data[(y * W + x) * C + 3] > 24) {
      any = true;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
  }
  if (!any) return { buf, w: W, h: H };
  const w = maxX - minX + 1, h = maxY - minY + 1;
  const out = await sharp(buf).extract({ left: minX, top: minY, width: w, height: h }).png().toBuffer();
  return { buf: out, w, h };
}

/**
 * Turn picked video frames into a clean horizontal sprite sheet: chroma-key
 * the seed's background color to transparent (+ despill the fringe),
 * alpha-trim each frame, then bottom-anchor into a uniform cell so
 * characters share a ground line instead of bobbing.
 *
 * @param {object} opts
 * @param {string} opts.framesDir  - directory of f_NNN.png from extractFrames()
 * @param {(number|string)[]} opts.picks - frame numbers to include, in order
 * @param {[number,number,number]} [opts.bg] - key color RGB, matches generateSeedFrame's magenta by default
 * @param {number} [opts.t0] - full-transparent color distance
 * @param {number} [opts.t1] - feather-edge color distance
 * @param {[number,number,number,number]} [opts.crop] - x,y,w,h source-px crop applied before keying
 * @param {number} [opts.pad] - transparent margin (px) inside each cell
 * @returns {Buffer} PNG sheet, frames left-to-right in pick order
 */
export async function buildAnimationSheet({ framesDir, picks, bg = [255, 0, 255], t0 = 70, t1 = 125, crop = null, pad = 10 }) {
  if (!picks?.length) throw new Error('buildAnimationSheet: picks must be a non-empty list of frame numbers');

  const keyed = [];
  for (const p of picks) {
    const file = path.join(framesDir, `f_${String(p).padStart(3, '0')}.png`);
    if (!fs.existsSync(file)) { console.warn(`missing ${file}, skipping`); continue; }
    const t = await trimToAlphaBbox(await keyFrame(file, bg, t0, t1, crop));
    keyed.push({ p, ...t });
  }
  if (!keyed.length) throw new Error('buildAnimationSheet: none of the requested picks were found');

  const cellH = Math.max(...keyed.map(k => k.h)) + pad * 2;
  const cellW = Math.max(...keyed.map(k => k.w)) + pad * 2;
  const sheetW = cellW * keyed.length;
  const composites = keyed.map((k, i) => ({
    input: k.buf,
    left: i * cellW + Math.round((cellW - k.w) / 2),
    top: cellH - pad - k.h, // bottom anchor
  }));

  const sheet = await sharp({
    create: { width: sheetW, height: cellH, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  }).composite(composites).png().toBuffer();

  return { buf: sheet, frameCount: keyed.length, cellW, cellH, sheetW, sheetH: cellH };
}
