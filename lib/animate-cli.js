/**
 * `sprite-generator animate <stage>` CLI entry.
 *
 * Four stages, run one at a time on purpose — the pipeline stops after
 * `extract` so you can look at the contact sheet before picking frames.
 * That's the one judgment call in the whole pipeline that can't be
 * automated, so it isn't.
 *
 *   sprite-generator animate seed   --prompt "..." --out seed.png
 *   sprite-generator animate motion --image seed.png --prompt "..." --out clip.mp4
 *   sprite-generator animate extract --video clip.mp4 --out frames/ --contact
 *   # ...look at frames/_contact.png, note the frame numbers you want...
 *   sprite-generator animate sheet  --framesDir frames/ --pick 16,26,33,47 --out sheet.png
 */
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { parseArgs } from 'util';
import OpenAI from 'openai';
import {
  generateSeedFrame, imageToVideo, extractFrames, buildAnimationSheet,
} from './animate-pipeline.js';

const USAGE = `Usage: sprite-generator animate <stage> [options]

Stages:
  seed     Generate one seed still via gpt-image-1
  motion   Animate the seed via a Replicate image-to-video model
  extract  Explode the resulting clip into numbered frames (+ contact sheet)
  sheet    Chroma-key + assemble your picked frames into a sprite sheet

Run "sprite-generator animate <stage> --help" for stage-specific options.`;

function mkOut(p) { fs.mkdirSync(path.dirname(path.resolve(p)) || '.', { recursive: true }); }

async function runSeed(argv) {
  const { values: a } = parseArgs({
    args: argv,
    options: {
      prompt: { type: 'string' },
      out: { type: 'string', default: 'seed.png' },
      bg: { type: 'string', default: 'magenta' }, // magenta | transparent
      size: { type: 'string', default: '1024x1024' },
    },
    strict: false,
  });
  if (!a.prompt) { console.error('--prompt is required, e.g. --prompt "a lean cyber-ninja hero, matte black armor..."'); process.exit(1); }
  if (!process.env.OPENAI_API_KEY) { console.error('Missing OPENAI_API_KEY environment variable.'); process.exit(1); }

  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  console.log(`→ generating seed frame (${a.bg} bg, ${a.size})...`);
  const buf = await generateSeedFrame({ openai, prompt: a.prompt, bg: a.bg, size: a.size });
  mkOut(a.out);
  fs.writeFileSync(a.out, buf);
  console.log(`✓ wrote ${a.out}`);
  if (a.bg === 'magenta') {
    console.log(`  next: sprite-generator animate motion --image ${a.out} --prompt "<describe the motion>" --out clip.mp4`);
  }
}

async function runMotion(argv) {
  const { values: a } = parseArgs({
    args: argv,
    options: {
      image: { type: 'string' },
      model: { type: 'string', default: 'kwaivgi/kling-v2.1' },
      'image-field': { type: 'string', default: 'start_image' },
      prompt: { type: 'string', default: '' },
      neg: { type: 'string', default: '' },
      extra: { type: 'string', default: '{}' },
      out: { type: 'string', default: 'clip.mp4' },
    },
    strict: false,
  });
  if (!a.image) { console.error('--image is required (the seed frame to animate)'); process.exit(1); }
  if (!a.prompt) { console.error('--prompt is required — describe the MOTION, not the character (the image already carries identity)'); process.exit(1); }
  if (!process.env.REPLICATE_API_TOKEN) { console.error('Missing REPLICATE_API_TOKEN environment variable.'); process.exit(1); }

  const imageBuf = fs.readFileSync(a.image);
  console.log(`→ submitting to ${a.model} (image ${(imageBuf.length / 1024).toFixed(0)}KB)`);
  const started = Date.now();
  const videoBuf = await imageToVideo({
    token: process.env.REPLICATE_API_TOKEN,
    imageBuf,
    model: a.model,
    imageField: a['image-field'],
    prompt: a.prompt,
    negativePrompt: a.neg,
    extra: JSON.parse(a.extra),
    onProgress: (status, elapsed) => process.stdout.write(`\r  ${status}  ${elapsed.toFixed(0)}s   `),
  });
  console.log('');
  mkOut(a.out);
  fs.writeFileSync(a.out, videoBuf);
  console.log(`✓ wrote ${a.out}  (${(videoBuf.length / 1024 / 1024).toFixed(1)}MB, ${((Date.now() - started) / 1000).toFixed(0)}s)`);
  console.log(`  next: sprite-generator animate extract --video ${a.out} --out frames/ --contact`);
}

async function runExtract(argv) {
  const { values: a } = parseArgs({
    args: argv,
    options: {
      video: { type: 'string' },
      out: { type: 'string', default: 'frames' },
      fps: { type: 'string', default: '' },
      contact: { type: 'boolean', default: false },
      cols: { type: 'string', default: '8' },
      thumb: { type: 'string', default: '220' },
    },
    strict: false,
  });
  if (!a.video) { console.error('--video is required'); process.exit(1); }

  console.log(`→ ffmpeg ${a.video} -> ${a.out}/f_%03d.png${a.fps ? ` @ ${a.fps}fps` : ' (every frame)'}`);
  const { frameFiles, contactPath } = await extractFrames({
    videoPath: a.video, outDir: a.out, fps: a.fps, contact: a.contact,
    cols: +a.cols, thumbWidth: +a.thumb,
  });
  console.log(`✓ ${frameFiles.length} frames in ${a.out}`);
  if (contactPath) {
    console.log(`✓ contact sheet: ${contactPath}`);
    console.log(`  LOOK AT IT, pick the frame numbers, then:`);
  } else {
    console.log(`  next: eyeball the frames, then:`);
  }
  console.log(`    sprite-generator animate sheet --framesDir ${a.out} --pick <n,n,n> --out sheet.png`);
}

async function runSheet(argv) {
  const { values: a } = parseArgs({
    args: argv,
    options: {
      framesDir: { type: 'string' },
      pick: { type: 'string' },
      out: { type: 'string', default: 'sheet.png' },
      bg: { type: 'string', default: '255,0,255' }, // matches generateSeedFrame's magenta
      t0: { type: 'string', default: '70' },
      t1: { type: 'string', default: '125' },
      crop: { type: 'string' },
      pad: { type: 'string', default: '10' },
    },
    strict: false,
  });
  if (!a.framesDir || !a.pick) { console.error('--framesDir and --pick are required, e.g. --pick 16,26,33,47'); process.exit(1); }

  const picks = a.pick.split(',').map(s => s.trim());
  const bg = a.bg.split(',').map(Number);
  const crop = a.crop ? a.crop.split(',').map(Number) : null;

  const { buf, frameCount, cellW, cellH, sheetW, sheetH } = await buildAnimationSheet({
    framesDir: a.framesDir, picks, bg, t0: +a.t0, t1: +a.t1, crop, pad: +a.pad,
  });
  mkOut(a.out);
  fs.writeFileSync(a.out, buf);
  console.log(`✓ ${a.out}  ${frameCount} frames, cell ${cellW}x${cellH}, sheet ${sheetW}x${sheetH}`);
}

export async function runAnimateCli(argv) {
  const stage = argv[0];
  const rest = argv.slice(1);
  switch (stage) {
    case 'seed': return runSeed(rest);
    case 'motion': return runMotion(rest);
    case 'extract': return runExtract(rest);
    case 'sheet': return runSheet(rest);
    default:
      console.log(USAGE);
      process.exit(stage ? 1 : 0);
  }
}
