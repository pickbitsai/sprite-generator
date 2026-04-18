#!/usr/bin/env node
/**
 * Sprite Generator - Agentic loop using OpenAI gpt-image-1
 *
 * Usage:
 *   OPENAI_API_KEY=sk-... node generate.js [options]
 *
 * Options:
 *   --manifest <path>   Path to asset manifest JSON (default: ./manifest.json)
 *   --output <dir>      Output directory for sprites (default: ./output)
 *   --style <prompt>    Style prompt prepended to all generations
 *   --size <WxH>        Image size (default: 1024x1024)
 *   --model <name>      Model to use (default: gpt-image-1)
 *   --category <name>   Only generate assets in this category
 *   --skip-existing     Skip assets that already have output files
 *   --concurrency <n>   Max parallel requests (default: 3)
 *   --dry-run           Print what would be generated without calling the API
 *   --no-sheet          Generate individual frames but skip sprite sheet assembly
 */

import fs from 'fs';
import path from 'path';
import { parseArgs } from 'util';
// OpenAI and sharp are imported dynamically so that `init` works without deps installed

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------
const { values: args } = parseArgs({
  options: {
    manifest:       { type: 'string',  default: './manifest.json' },
    output:         { type: 'string',  default: './output' },
    style:          { type: 'string',  default: '' },
    size:           { type: 'string',  default: '1024x1024' },
    model:          { type: 'string',  default: 'gpt-image-1' },
    category:       { type: 'string',  default: '' },
    'skip-existing':{ type: 'boolean', default: false },
    concurrency:    { type: 'string',  default: '3' },
    'dry-run':      { type: 'boolean', default: false },
    'no-sheet':     { type: 'boolean', default: false },
  },
  strict: false,
  allowPositionals: true,
});

// ---------------------------------------------------------------------------
// Init subcommand — create a starter manifest
// ---------------------------------------------------------------------------
if (process.argv[2] === 'init') {
  const manifestPath = path.resolve('manifest.json');
  if (fs.existsSync(manifestPath)) {
    console.error('manifest.json already exists in this directory. Delete it first to re-init.');
    process.exit(1);
  }
  const starter = {
    defaultStyle: 'Illustrated game sprite, transparent background, 256x256, detailed, centered composition, no text',
    angles: ['front'],
    animations: {
      idle: { frames: 1, fps: 1 }
    },
    assets: [
      {
        id: 'example_hero',
        name: 'Hero',
        emoji: '\u{1F9B8}',
        category: 'character',
        description: 'A heroic character in a standing pose, detailed and vibrant',
        tags: ['character', 'hero', 'main'],
        angles: ['front', 'side'],
        animations: {
          idle: { frames: 2, fps: 4 },
          walk: { frames: 4, fps: 8 }
        }
      }
    ]
  };
  fs.writeFileSync(manifestPath, JSON.stringify(starter, null, 2) + '\n');
  console.log('Created manifest.json with a starter template.');
  console.log('');
  console.log('Next steps:');
  console.log('  1. Edit manifest.json — set your art style, add assets');
  console.log('  2. Preview prompts:  npx sprite-generator --dry-run');
  console.log('  3. Generate sprites: OPENAI_API_KEY=sk-... npx sprite-generator');
  console.log('  4. View results:     npx sprite-preview');
  console.log('');
  console.log('Sprite sheet fields (optional per asset):');
  console.log('  "angles": ["front", "back", "left", "right"]');
  console.log('  "animations": { "idle": { "frames": 2, "fps": 4 }, "walk": { "frames": 4, "fps": 8 } }');
  console.log('');
  console.log('Assets without angles/animations produce a single PNG.');
  process.exit(0);
}

const VALID_SIZES = ['1024x1024', '1024x1536', '1536x1024', 'auto'];
if (!VALID_SIZES.includes(args.size)) {
  console.error(`Invalid size "${args.size}". Use one of: ${VALID_SIZES.join(', ')}`);
  process.exit(1);
}

const VALID_MODELS = ['gpt-image-1', 'dall-e-3'];
const model = args.model || 'gpt-image-1';
if (!VALID_MODELS.includes(model)) {
  console.error(`Invalid model "${model}". Use one of: ${VALID_MODELS.join(', ')}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Load manifest
// ---------------------------------------------------------------------------
const manifestPath = path.resolve(args.manifest);
if (!fs.existsSync(manifestPath)) {
  console.error(`Manifest not found: ${manifestPath}`);
  process.exit(1);
}

const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
let assets = manifest.assets || [];

// Filter by category
if (args.category) {
  assets = assets.filter(a => a.category === args.category);
}

if (assets.length === 0) {
  console.log('No assets to generate.');
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------
const outputDir = path.resolve(args.output);
fs.mkdirSync(outputDir, { recursive: true });

const defaultStyle = manifest.defaultStyle ||
  'Illustrated sprite on a transparent background, 256x256, detailed, game asset';

const stylePrompt = args.style || defaultStyle;
const concurrency = parseInt(args.concurrency, 10) || 3;

// ---------------------------------------------------------------------------
// Built-in animation phase descriptions
// ---------------------------------------------------------------------------
const PHASE_DESCRIPTIONS = {
  idle: [
    'standing still, relaxed neutral pose',
    'standing still, subtle breathing motion',
    'standing still, slight weight shift',
    'standing still, gentle blink or sway',
  ],
  walk: [
    'starting step, left foot forward',
    'mid-stride, left foot planted',
    'passing position, feet together',
    'starting step, right foot forward',
    'mid-stride, right foot planted',
    'passing position, returning to start',
  ],
  run: [
    'push off, back leg extended',
    'airborne, both feet off ground',
    'landing, front foot striking',
    'drive phase, knee high',
    'airborne again, opposite side',
    'landing, opposite foot striking',
  ],
  attack: [
    'winding up, weapon raised behind',
    'mid-swing, full forward extension',
    'impact moment, maximum reach',
    'follow-through, returning to ready stance',
  ],
  jump: [
    'crouching, preparing to leap',
    'launching upward, legs extending',
    'apex, airborne at highest point',
    'descending, legs tucking',
    'landing, knees bending to absorb',
  ],
  death: [
    'hit reaction, recoiling from impact',
    'stumbling, losing balance',
    'falling, body going limp',
    'collapsed on the ground, motionless',
  ],
};

// ---------------------------------------------------------------------------
// Resolve per-asset frame configuration
// ---------------------------------------------------------------------------
function resolveAssetFrames(asset, manifest) {
  const angles = asset.angles || manifest.angles || null;
  const anims = asset.animations || manifest.animations || null;

  // Simple asset — no angles or animations
  if (!angles && !anims) {
    return { isSheet: false, jobs: [{ angle: null, animation: null, frameIndex: null, totalFrames: null }] };
  }

  const angleList = angles || [null];
  const animEntries = anims ? Object.entries(anims) : [[null, { frames: 1 }]];

  const jobs = [];
  for (const angle of angleList) {
    for (const [animName, animConfig] of animEntries) {
      const frameCount = animConfig.frames || 1;
      for (let i = 0; i < frameCount; i++) {
        jobs.push({
          angle,
          animation: animName,
          frameIndex: i,
          totalFrames: frameCount,
          frameDescriptions: animConfig.frameDescriptions || null,
        });
      }
    }
  }

  return {
    isSheet: true,
    angles: angleList.filter(Boolean),
    animations: anims || {},
    jobs,
  };
}

// ---------------------------------------------------------------------------
// Prompt builder
// ---------------------------------------------------------------------------
function buildPrompt(asset, style, { angle = null, animation = null, frameIndex = null, totalFrames = null, frameDescriptions = null } = {}) {
  const parts = [style];

  if (asset.description) {
    parts.push(asset.description);
  } else {
    parts.push(`A ${asset.name}`);
  }

  if (angle) {
    parts.push(`Viewed from the ${angle}, ${angle}-facing perspective`);
  }

  if (animation && frameIndex !== null) {
    // Use custom frame descriptions if provided, else built-in, else generic
    let phaseDesc;
    if (frameDescriptions && frameDescriptions[frameIndex]) {
      phaseDesc = frameDescriptions[frameIndex];
    } else if (PHASE_DESCRIPTIONS[animation]) {
      const phases = PHASE_DESCRIPTIONS[animation];
      phaseDesc = phases[frameIndex % phases.length];
    } else {
      phaseDesc = `frame ${frameIndex + 1} of ${totalFrames} of the ${animation} animation`;
    }
    parts.push(`${animation} animation: ${phaseDesc}`);
    parts.push(`This is frame ${frameIndex + 1} of ${totalFrames} in a sprite animation sequence. Maintain exact same character design, colors, proportions, and outfit across all frames. Only the pose changes`);
  }

  if (asset.tags && asset.tags.length > 0) {
    parts.push(`Keywords: ${asset.tags.join(', ')}`);
  }

  return parts.join('. ') + '.';
}

// ---------------------------------------------------------------------------
// Build flat job list from assets
// ---------------------------------------------------------------------------
function buildJobList(assets, manifest) {
  const jobs = [];
  const sheetAssets = [];

  for (const asset of assets) {
    const config = resolveAssetFrames(asset, manifest);
    const categoryDir = path.join(outputDir, asset.category || 'misc');

    if (!config.isSheet) {
      // Simple asset — single PNG
      jobs.push({
        asset,
        angle: null,
        animation: null,
        frameIndex: null,
        totalFrames: null,
        frameDescriptions: null,
        outPath: path.join(categoryDir, `${asset.id}.png`),
        isSheet: false,
      });
    } else {
      // Sheet asset — one job per frame
      const framesDir = path.join(categoryDir, asset.id, 'frames');
      for (const frame of config.jobs) {
        const parts = [frame.angle, frame.animation, frame.frameIndex].filter(x => x !== null);
        const filename = `${parts.join('-')}.png`;
        jobs.push({
          asset,
          ...frame,
          outPath: path.join(framesDir, filename),
          isSheet: true,
        });
      }
      sheetAssets.push({ asset, config, categoryDir });
    }
  }

  return { jobs, sheetAssets };
}

// ---------------------------------------------------------------------------
// Filter existing & dry-run
// ---------------------------------------------------------------------------
let { jobs, sheetAssets } = buildJobList(assets, manifest);

if (args['skip-existing']) {
  const before = jobs.length;
  jobs = jobs.filter(job => !fs.existsSync(job.outPath));
  console.log(`${jobs.length}/${before} jobs remaining after skipping existing.`);
}

if (args['dry-run']) {
  const simpleJobs = jobs.filter(j => !j.isSheet);
  const sheetJobs = jobs.filter(j => j.isSheet);

  console.log(`\nDry run — ${jobs.length} total API calls:\n`);

  if (simpleJobs.length > 0) {
    console.log(`  Simple sprites: ${simpleJobs.length}`);
    for (const job of simpleJobs) {
      console.log(`    [${job.asset.category}] ${job.asset.id}: ${job.asset.name} (${job.asset.emoji || ''})`);
      console.log(`      Prompt: "${buildPrompt(job.asset, stylePrompt)}"\n`);
    }
  }

  if (sheetJobs.length > 0) {
    console.log(`  Sprite sheet frames: ${sheetJobs.length}`);
    // Group by asset
    const byAsset = new Map();
    for (const job of sheetJobs) {
      if (!byAsset.has(job.asset.id)) byAsset.set(job.asset.id, []);
      byAsset.get(job.asset.id).push(job);
    }
    for (const [id, assetJobs] of byAsset) {
      const asset = assetJobs[0].asset;
      const config = resolveAssetFrames(asset, manifest);
      console.log(`    [${asset.category}] ${id}: ${asset.name} (${asset.emoji || ''}) — ${assetJobs.length} frames`);
      console.log(`      Angles: ${config.angles.join(', ')}`);
      console.log(`      Animations: ${Object.entries(config.animations).map(([k, v]) => `${k} (${v.frames}f)`).join(', ')}`);
      // Show first frame prompt as sample
      const sample = assetJobs[0];
      console.log(`      Sample prompt: "${buildPrompt(sample.asset, stylePrompt, sample)}"\n`);
    }
  }

  process.exit(0);
}

// ---------------------------------------------------------------------------
// OpenAI client
// ---------------------------------------------------------------------------
if (!process.env.OPENAI_API_KEY) {
  console.error('Missing OPENAI_API_KEY environment variable.');
  process.exit(1);
}

const { default: OpenAI } = await import('openai');
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ---------------------------------------------------------------------------
// Generate a single frame
// ---------------------------------------------------------------------------
async function generateFrame(job, retries = 2) {
  const prompt = buildPrompt(job.asset, stylePrompt, job);
  fs.mkdirSync(path.dirname(job.outPath), { recursive: true });

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const response = await openai.images.generate({
        model,
        prompt,
        n: 1,
        size: args.size,
        ...(model === 'dall-e-3' ? { quality: 'standard' } : {}),
      });

      // gpt-image-1 returns base64 by default
      const b64 = response.data[0].b64_json;
      if (b64) {
        fs.writeFileSync(job.outPath, Buffer.from(b64, 'base64'));
      } else if (response.data[0].url) {
        const res = await fetch(response.data[0].url);
        const buf = Buffer.from(await res.arrayBuffer());
        fs.writeFileSync(job.outPath, buf);
      }

      return { id: job.asset.id, status: 'ok', path: job.outPath };
    } catch (err) {
      if (attempt < retries && (err.status === 429 || err.status >= 500)) {
        const wait = Math.pow(2, attempt + 1) * 1000;
        console.warn(`  Retry ${attempt + 1}/${retries} for ${path.basename(job.outPath)} in ${wait / 1000}s...`);
        await sleep(wait);
        continue;
      }
      return { id: job.asset.id, status: 'error', error: err.message, path: job.outPath };
    }
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Parallel runner with concurrency limit
// ---------------------------------------------------------------------------
async function runBatch(jobs, concurrency) {
  const results = [];
  let index = 0;
  const total = jobs.length;

  async function worker() {
    while (index < total) {
      const i = index++;
      const job = jobs[i];
      const progress = `[${i + 1}/${total}]`;
      const label = job.isSheet
        ? `${job.asset.category}/${job.asset.id}/${job.angle || ''}-${job.animation || ''}-${job.frameIndex ?? ''}`
        : `${job.asset.category}/${job.asset.id}`;
      console.log(`${progress} Generating ${label} — ${job.asset.name}...`);
      const result = await generateFrame(job);
      if (result.status === 'ok') {
        console.log(`${progress} \u2713 ${path.basename(result.path)}`);
      } else {
        console.error(`${progress} \u2717 ${path.basename(result.path)}: ${result.error}`);
      }
      results.push(result);
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, total) }, () => worker());
  await Promise.all(workers);
  return results;
}

// ---------------------------------------------------------------------------
// Sprite sheet assembly
// ---------------------------------------------------------------------------
async function assembleSheets(sheetAssets, results) {
  if (args['no-sheet'] || sheetAssets.length === 0) return;

  const { default: sharp } = await import('sharp');

  // Parse frame dimensions from the generated size
  const [frameWidth, frameHeight] = args.size === 'auto'
    ? [1024, 1024]
    : args.size.split('x').map(Number);

  for (const { asset, config, categoryDir } of sheetAssets) {
    const assetDir = path.join(categoryDir, asset.id);
    const framesDir = path.join(assetDir, 'frames');

    // Check that we have frames to assemble
    const assetResults = results.filter(r => r.id === asset.id && r.status === 'ok');
    if (assetResults.length === 0) {
      console.warn(`  Skipping sheet for ${asset.id} — no successful frames.`);
      continue;
    }

    const angles = config.angles.length > 0 ? config.angles : [null];
    const animEntries = Object.entries(config.animations);
    const totalFramesPerRow = animEntries.reduce((sum, [, v]) => sum + (v.frames || 1), 0);
    const rows = angles.length;
    const columns = totalFramesPerRow;
    const sheetWidth = columns * frameWidth;
    const sheetHeight = rows * frameHeight;

    // Build composite operations and frameMap
    const composites = [];
    const frameMap = [];
    let idx = 0;

    for (let row = 0; row < angles.length; row++) {
      const angle = angles[row];
      let col = 0;
      for (const [animName, animConfig] of animEntries) {
        const frameCount = animConfig.frames || 1;
        for (let f = 0; f < frameCount; f++) {
          const parts = [angle, animName, f].filter(x => x !== null);
          const framePath = path.join(framesDir, `${parts.join('-')}.png`);
          if (fs.existsSync(framePath)) {
            composites.push({
              input: framePath,
              left: col * frameWidth,
              top: row * frameHeight,
            });
          }
          frameMap.push({
            index: idx,
            angle: angle || null,
            animation: animName,
            frame: f,
            x: col * frameWidth,
            y: row * frameHeight,
          });
          col++;
          idx++;
        }
      }
    }

    // Assemble the sheet
    const sheetPath = path.join(assetDir, `${asset.id}-sheet.png`);
    try {
      await sharp({
        create: {
          width: sheetWidth,
          height: sheetHeight,
          channels: 4,
          background: { r: 0, g: 0, b: 0, alpha: 0 },
        },
      })
        .composite(composites)
        .png()
        .toFile(sheetPath);

      // Write metadata
      const metadata = {
        id: asset.id,
        image: `${asset.id}-sheet.png`,
        frameWidth,
        frameHeight,
        columns,
        rows,
        angles: config.angles,
        animations: Object.fromEntries(
          animEntries.map(([name, cfg]) => [name, { frames: cfg.frames || 1, fps: cfg.fps || 8 }])
        ),
        frameMap,
      };
      const metaPath = path.join(assetDir, `${asset.id}-sheet.json`);
      fs.writeFileSync(metaPath, JSON.stringify(metadata, null, 2));

      console.log(`  \u2713 Sheet assembled: ${sheetPath} (${columns}x${rows} grid, ${composites.length} frames)`);
    } catch (err) {
      console.error(`  \u2717 Sheet assembly failed for ${asset.id}: ${err.message}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
const simpleCount = jobs.filter(j => !j.isSheet).length;
const sheetFrameCount = jobs.filter(j => j.isSheet).length;

console.log(`\nSprite Generator`);
console.log(`  Manifest: ${manifestPath}`);
console.log(`  Output:   ${outputDir}`);
console.log(`  Model:    ${model}`);
console.log(`  Size:     ${args.size}`);
console.log(`  Style:    "${stylePrompt.slice(0, 80)}..."`);
console.log(`  Assets:   ${assets.length} (${simpleCount} simple, ${sheetFrameCount} sheet frames)`);
console.log(`  API calls: ${jobs.length}`);
console.log(`  Workers:  ${concurrency}\n`);

const startTime = Date.now();
const results = await runBatch(jobs, concurrency);
const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

const ok = results.filter(r => r.status === 'ok').length;
const failed = results.filter(r => r.status === 'error').length;

console.log(`\nGeneration done in ${elapsed}s — ${ok} generated, ${failed} failed.`);

// Assemble sprite sheets
if (sheetAssets.length > 0 && !args['no-sheet']) {
  console.log(`\nAssembling ${sheetAssets.length} sprite sheet(s)...`);
  await assembleSheets(sheetAssets, results);
}

// Write a results log
const logPath = path.join(outputDir, 'generation-log.json');
fs.writeFileSync(logPath, JSON.stringify({
  timestamp: new Date().toISOString(),
  style: stylePrompt,
  size: args.size,
  results,
}, null, 2));
console.log(`\nLog written to ${logPath}`);

if (failed > 0) {
  process.exit(1);
}
