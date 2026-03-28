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

import fs from 'fs';
import path from 'path';
import { parseArgs } from 'util';
import OpenAI from 'openai';

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------
const { values: args } = parseArgs({
  options: {
    manifest:       { type: 'string',  default: './manifest.json' },
    output:         { type: 'string',  default: './output' },
    style:          { type: 'string',  default: '' },
    size:           { type: 'string',  default: '256x256' },
    model:          { type: 'string',  default: 'gpt-image-1' },
    category:       { type: 'string',  default: '' },
    'skip-existing':{ type: 'boolean', default: false },
    concurrency:    { type: 'string',  default: '3' },
    'dry-run':      { type: 'boolean', default: false },
  },
  strict: false,
});

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
if (!process.env.OPENAI_API_KEY) {
  console.error('Missing OPENAI_API_KEY environment variable.');
  process.exit(1);
}

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

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
        fs.writeFileSync(outPath, Buffer.from(b64, 'base64'));
      } else if (response.data[0].url) {
        // Fallback: download from URL
        const res = await fetch(response.data[0].url);
        const buf = Buffer.from(await res.arrayBuffer());
        fs.writeFileSync(outPath, buf);
      }

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
console.log(`  Model:    ${model}`);
console.log(`  Size:     ${args.size}`);
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
