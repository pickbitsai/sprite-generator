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
 *   --style <prompt>     Style prompt prepended to all generations
 *   --size <WxH>        Image size (default: 256x256, options: 256x256, 512x512, 1024x1024)
 *   --category <name>   Only generate assets in this category
 *   --skip-existing     Skip assets that already have output files
 *   --concurrency <n>   Max parallel requests (default: 3)
 *   --dry-run           Print what would be generated without calling the API
 */

import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { parseArgs } from 'util';
import OpenAI from 'openai';
import { GoogleGenAI } from '@google/genai';

if (process.argv[2] === 'init') {
  const { runInit } = await import('./lib/init.js');
  await runInit(process.argv.slice(3));
  process.exit(0);
}

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
    backend:        { type: 'string',  default: 'openai' },
    seed:           { type: 'string',  default: '' },
    category:       { type: 'string',  default: '' },
    'skip-existing':{ type: 'boolean', default: false },
    concurrency:    { type: 'string',  default: '3' },
    'dry-run':      { type: 'boolean', default: false },
  },
  strict: false,
});

const VALID_BACKENDS = ['openai', 'imagen'];
const backend = args.backend || 'openai';
if (!VALID_BACKENDS.includes(backend)) {
  console.error(`Invalid backend "${backend}". Use one of: ${VALID_BACKENDS.join(', ')}`);
  process.exit(1);
}

const VALID_SIZES_OPENAI = ['1024x1024', '1024x1536', '1536x1024', 'auto'];
if (backend === 'openai' && !VALID_SIZES_OPENAI.includes(args.size)) {
  console.error(`Invalid size "${args.size}" for openai. Use one of: ${VALID_SIZES_OPENAI.join(', ')}`);
  process.exit(1);
}

const VALID_MODELS_OPENAI = ['gpt-image-1', 'dall-e-3'];
const VALID_MODELS_IMAGEN = ['imagen-4.0-generate-001', 'imagen-4.0-fast-generate-001', 'imagen-3.0-generate-002'];
let model = args.model;
if (backend === 'openai') {
  if (model === 'gpt-image-1' || !model) model = 'gpt-image-1';
  if (!VALID_MODELS_OPENAI.includes(model)) {
    console.error(`Invalid model "${model}" for openai. Use one of: ${VALID_MODELS_OPENAI.join(', ')}`);
    process.exit(1);
  }
} else if (backend === 'imagen') {
  if (model === 'gpt-image-1' || !model) model = 'imagen-4.0-generate-001';
  if (!VALID_MODELS_IMAGEN.includes(model)) {
    console.error(`Invalid model "${model}" for imagen. Use one of: ${VALID_MODELS_IMAGEN.join(', ')}`);
    process.exit(1);
  }
}

const baseSeed = args.seed ? parseInt(args.seed, 10) : null;

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
  'Dark fantasy illustrated sprite on a transparent background, 256x256, detailed, gothic, moody lighting, game asset';

const stylePrompt = args.style || defaultStyle;
const concurrency = parseInt(args.concurrency, 10) || 3;

// ---------------------------------------------------------------------------
// Filter existing
// ---------------------------------------------------------------------------
if (args['skip-existing']) {
  assets = assets.filter(asset => {
    const outPath = path.join(outputDir, asset.category || '', `${asset.id}.png`);
    return !fs.existsSync(outPath);
  });
  console.log(`${assets.length} assets remaining after skipping existing.`);
}

if (args['dry-run']) {
  console.log(`\nDry run — would generate ${assets.length} sprites:\n`);
  for (const asset of assets) {
    console.log(`  [${asset.category}] ${asset.id}: ${asset.name} (${asset.emoji})`);
    console.log(`    Prompt: "${buildPrompt(asset, stylePrompt)}"\n`);
  }
  process.exit(0);
}

// ---------------------------------------------------------------------------
// OpenAI client
// ---------------------------------------------------------------------------
let openai = null;
let genai = null;

if (backend === 'openai') {
  if (!process.env.OPENAI_API_KEY) {
    console.error('Missing OPENAI_API_KEY environment variable.');
    process.exit(1);
  }
  openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
} else if (backend === 'imagen') {
  if (!process.env.GEMINI_API_KEY) {
    console.error('Missing GEMINI_API_KEY environment variable.');
    process.exit(1);
  }
  genai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
}

// Hash a string into a stable 32-bit unsigned int (for per-asset seed derivation)
function hashSeed(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// ---------------------------------------------------------------------------
// Prompt builder
// ---------------------------------------------------------------------------
function buildPrompt(asset, style) {
  const parts = [style];

  if (asset.description) {
    parts.push(asset.description);
  } else {
    parts.push(`A ${asset.name}`);
  }

  if (asset.tags && asset.tags.length > 0) {
    parts.push(`Keywords: ${asset.tags.join(', ')}`);
  }

  return parts.join('. ') + '.';
}

// ---------------------------------------------------------------------------
// Generate a single sprite
// ---------------------------------------------------------------------------
async function generateSprite(asset, retries = 2) {
  const prompt = buildPrompt(asset, stylePrompt);
  const categoryDir = path.join(outputDir, asset.category || 'misc');
  fs.mkdirSync(categoryDir, { recursive: true });
  const outPath = path.join(categoryDir, `${asset.id}.png`);

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      let b64 = null;

      if (backend === 'openai') {
        const response = await openai.images.generate({
          model,
          prompt,
          n: 1,
          size: args.size,
          ...(model === 'dall-e-3' ? { quality: 'standard' } : {}),
        });
        b64 = response.data[0].b64_json;
        if (!b64 && response.data[0].url) {
          const res = await fetch(response.data[0].url);
          b64 = Buffer.from(await res.arrayBuffer()).toString('base64');
        }
      } else if (backend === 'imagen') {
        // Per-asset seed: identity-stable within a class if baseSeed is set.
        // Derive from class (category) so every frame of a class shares a seed,
        // which is what pushes Imagen toward 1:1 replicas across frames.
        const seed = baseSeed != null
          ? (baseSeed + hashSeed(asset.category || 'default')) >>> 0
          : undefined;
        const response = await genai.models.generateImages({
          model,
          prompt,
          config: {
            numberOfImages: 1,
            aspectRatio: '1:1',
            ...(seed !== undefined ? { seed, addWatermark: false } : {}),
          },
        });
        b64 = response?.generatedImages?.[0]?.image?.imageBytes;
      }

      if (!b64) throw new Error('No image bytes returned');
      fs.writeFileSync(outPath, Buffer.from(b64, 'base64'));

      return { id: asset.id, status: 'ok', path: outPath };
    } catch (err) {
      if (attempt < retries && (err.status === 429 || err.status >= 500)) {
        const wait = Math.pow(2, attempt + 1) * 1000;
        console.warn(`  Retry ${attempt + 1}/${retries} for ${asset.id} in ${wait / 1000}s...`);
        await sleep(wait);
        continue;
      }
      return { id: asset.id, status: 'error', error: err.message };
    }
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Parallel runner with concurrency limit
// ---------------------------------------------------------------------------
async function runBatch(assets, concurrency) {
  const results = [];
  let index = 0;
  const total = assets.length;

  async function worker() {
    while (index < total) {
      const i = index++;
      const asset = assets[i];
      const progress = `[${i + 1}/${total}]`;
      console.log(`${progress} Generating ${asset.category}/${asset.id} — ${asset.name}...`);
      const result = await generateSprite(asset);
      if (result.status === 'ok') {
        console.log(`${progress} ✓ ${asset.id}`);
      } else {
        console.error(`${progress} ✗ ${asset.id}: ${result.error}`);
      }
      results.push(result);
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, total) }, () => worker());
  await Promise.all(workers);
  return results;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
console.log(`\nSprite Generator`);
console.log(`  Manifest: ${manifestPath}`);
console.log(`  Output:   ${outputDir}`);
console.log(`  Backend:  ${backend}`);
console.log(`  Model:    ${model}`);
console.log(`  Size:     ${args.size}`);
console.log(`  Seed:     ${baseSeed != null ? baseSeed : '(none)'}`);
console.log(`  Style:    "${stylePrompt.slice(0, 80)}..."`);
console.log(`  Assets:   ${assets.length}`);
console.log(`  Workers:  ${concurrency}\n`);

const startTime = Date.now();
const results = await runBatch(assets, concurrency);
const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

const ok = results.filter(r => r.status === 'ok').length;
const failed = results.filter(r => r.status === 'error').length;

console.log(`\nDone in ${elapsed}s — ${ok} generated, ${failed} failed.`);

// Write a results log
const logPath = path.join(outputDir, 'generation-log.json');
fs.writeFileSync(logPath, JSON.stringify({
  timestamp: new Date().toISOString(),
  style: stylePrompt,
  size: args.size,
  results,
}, null, 2));
console.log(`Log written to ${logPath}`);

if (failed > 0) {
  process.exit(1);
}
