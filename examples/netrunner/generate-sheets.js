#!/usr/bin/env node
/**
 * Sheet-based sprite generator using Gemini 2.5 Flash Image.
 * Groups a per-frame anim manifest by (category, action), asks the model
 * for one grid image per group, then slices it into individual frames.
 *
 * Usage:
 *   GEMINI_API_KEY=... node generate-sheets.js --manifest ./netrunner-anim-manifest.json
 *
 * Options:
 *   --manifest <path>    Per-frame anim manifest (default ./manifest.json)
 *   --output <dir>       Output dir (default ./output)
 *   --cell <N>           Output cell size in px (default 256)
 *   --model <id>         Gemini image model (default gemini-2.5-flash-image)
 *   --skip-existing      Skip sheets where all target frames already exist
 *   --only <group>       Only run a single group key (e.g. "netrunner-full/idle|idle")
 *   --dry-run            Plan only, no API calls
 */

import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { parseArgs } from 'util';
import { GoogleGenAI } from '@google/genai';
import sharp from 'sharp';

const { values: args } = parseArgs({
  options: {
    manifest:       { type: 'string',  default: './manifest.json' },
    output:         { type: 'string',  default: './output' },
    cell:           { type: 'string',  default: '256' },
    model:          { type: 'string',  default: 'gemini-2.5-flash-image' },
    strategy:       { type: 'string',  default: 'per-direction' }, // per-direction | auto | multi-row
    'skip-existing':{ type: 'boolean', default: false },
    only:           { type: 'string',  default: '' },
    'dry-run':      { type: 'boolean', default: false },
  },
  strict: false,
});

const CELL = parseInt(args.cell, 10) || 256;

const manifestPath = path.resolve(args.manifest);
if (!fs.existsSync(manifestPath)) {
  console.error(`Manifest not found: ${manifestPath}`);
  process.exit(1);
}
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
const outputDir = path.resolve(args.output);
fs.mkdirSync(outputDir, { recursive: true });

// ---------------------------------------------------------------------------
// Parse an asset id like "netrunner_walk_down_01" → {action, direction, frame}
// Falls back gracefully for non-conforming ids (e.g. "netrunner_death_04").
// ---------------------------------------------------------------------------
const DIRS = ['down', 'up', 'left', 'right'];
function parseId(id) {
  const m = id.match(/^(.+?)_([a-z]+?)(?:_(down|up|left|right))?_(\d+)$/);
  if (!m) return null;
  return {
    base:      m[1],
    action:    m[2],
    direction: m[3] || 'none',
    frame:     parseInt(m[4], 10),
  };
}

// ---------------------------------------------------------------------------
// Group assets by (category, action). Each group becomes one sheet.
// Rows = directions present, sorted [down, up, left, right, none].
// Cols = max frame number across directions in the group.
// ---------------------------------------------------------------------------
const DIR_ORDER = ['down', 'up', 'left', 'right', 'none'];
const groups = new Map();
for (const asset of manifest.assets || []) {
  const parsed = parseId(asset.id);
  if (!parsed) continue;
  const key = `${asset.category}|${parsed.action}`;
  if (!groups.has(key)) groups.set(key, { category: asset.category, action: parsed.action, rows: new Map() });
  const g = groups.get(key);
  if (!g.rows.has(parsed.direction)) g.rows.set(parsed.direction, []);
  g.rows.get(parsed.direction).push({ asset, parsed });
}

// Finalize: assign row/col indices, sort frames.
const sheets = [];
for (const [key, g] of groups) {
  const rowDirs = DIR_ORDER.filter(d => g.rows.has(d));
  let cols = 0;
  const cells = [];
  rowDirs.forEach((dir, rowIdx) => {
    const frames = g.rows.get(dir).sort((a, b) => a.parsed.frame - b.parsed.frame);
    if (frames.length > cols) cols = frames.length;
    frames.forEach((f, colIdx) => {
      cells.push({ row: rowIdx, col: colIdx, direction: dir, ...f });
    });
  });
  sheets.push({
    key,
    category: g.category,
    action: g.action,
    rows: rowDirs.length,
    cols,
    rowDirs,
    cells,
  });
}

const targetSheets = args.only ? sheets.filter(s => s.key === args.only) : sheets;

console.log(`\nSheet Generator (Gemini 2.5 Flash Image)`);
console.log(`  Manifest: ${manifestPath}`);
console.log(`  Output:   ${outputDir}`);
console.log(`  Model:    ${args.model}`);
console.log(`  Cell:     ${CELL}px`);
console.log(`  Sheets:   ${targetSheets.length}\n`);

for (const s of targetSheets) {
  console.log(`  ${s.key}  [${s.rows}r x ${s.cols}c, ${s.cells.length} frames]`);
}

if (args['dry-run']) {
  console.log('\nDry run — no API calls made.');
  process.exit(0);
}

if (!process.env.GEMINI_API_KEY) {
  console.error('Missing GEMINI_API_KEY environment variable.');
  process.exit(1);
}

const genai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// Pick the Gemini-supported aspect ratio closest to cols:rows.
// Supported: 1:1, 2:3, 3:2, 3:4, 4:3, 4:5, 5:4, 9:16, 16:9, 21:9.
const SUPPORTED_RATIOS = [
  ['1:1', 1],
  ['5:4', 1.25], ['4:5', 0.8],
  ['4:3', 1.333], ['3:4', 0.75],
  ['3:2', 1.5], ['2:3', 0.667],
  ['16:9', 1.778], ['9:16', 0.5625],
  ['21:9', 2.333],
];
function pickAspect(cols, rows) {
  const target = cols / rows;
  let best = SUPPORTED_RATIOS[0];
  let bestDiff = Infinity;
  for (const r of SUPPORTED_RATIOS) {
    const d = Math.abs(Math.log(r[1]) - Math.log(target));
    if (d < bestDiff) { bestDiff = d; best = r; }
  }
  return best[0];
}

// ---------------------------------------------------------------------------
// Build the sheet prompt. Character description is pulled from the first
// asset's description (all frames in a group share the same character).
// ---------------------------------------------------------------------------
function buildSheetPrompt(sheet, manifest, { hasReference }) {
  const first = sheet.cells[0].asset;
  const character = (first.description || '').split('.')[0];

  const rowDescs = sheet.rowDirs.map((dir, i) => {
    const row = sheet.cells.filter(c => c.row === i).sort((a, b) => a.col - b.col);
    const frameNotes = row.map(c => {
      const desc = c.asset.description || '';
      const motion = desc.split('.').slice(1).join('.').trim();
      return `col ${c.col + 1}: ${motion}`;
    }).join(' | ');
    return `Row ${i + 1} facing ${dir}: ${frameNotes}`;
  }).join('\n');

  const identityLine = hasReference
    ? `The reference image defines the character. Render the IDENTICAL character — same face, outfit, colors, proportions, line weight, rendering style. Only pose and facing direction change per cell.`
    : `Character: ${character}. All cells show the same character; only pose and facing direction change.`;

  return [
    `Produce a ${sheet.rows}-row by ${sheet.cols}-column sprite sheet, one image.`,
    `Solid ${CHROMA.hex} ${CHROMA.name} background (${CHROMA.rgbText}) everywhere except the character. The character itself must NOT contain ${CHROMA.name} tones. No shadows, no text, no borders, no gridlines, no glow.`,
    `Painted/illustrated art style. Not pixel art.`,
    identityLine,
    ``,
    `Cells:`,
    rowDescs,
  ].join('\n');
}

// Build a prompt for the one-off hero frame (single character, no grid).
function buildHeroPrompt(manifest, seedAsset) {
  const character = (seedAsset.description || '').split('.')[0];
  const style = manifest.defaultStyle || '';
  return [
    `Single character portrait, centered on a solid ${CHROMA.hex} ${CHROMA.name} background (${CHROMA.rgbText}).`,
    `The character itself must NOT contain ${CHROMA.name} tones.`,
    `No shadow, no text, no border, no glow. Painted/illustrated art style. Not pixel art.`,
    `Character: ${character}, facing toward the camera (south/down), standing idle with arms relaxed at sides.`,
    `Style: ${style}`,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Slice a sheet PNG buffer into cells and save each to its asset output path.
// ---------------------------------------------------------------------------
// Remove magenta chroma (#ff00ff-ish) from raw RGBA by setting alpha=0.
// Tolerance handles JPEG/model compression around the key color.
// Key pixels of a target hue to alpha=0. The "hue family" test looks at which
// channel(s) dominate so we can catch softer/darker tints of the key color.
// Supported families: 'magenta' (R,B > G), 'green' (G > R,B), 'cyan' (G,B > R).
function chromaKey(rgba, family) {
  let keyed = 0;
  for (let i = 0; i < rgba.length; i += 4) {
    const r = rgba[i], g = rgba[i + 1], b = rgba[i + 2];
    let hit = false;
    if (family === 'magenta') {
      const rg = r - g, bg = b - g, rb = Math.abs(r - b);
      hit = rg > 25 && bg > 15 && rb < Math.max(r, b) * 0.45;
    } else if (family === 'green') {
      const gr = g - r, gb = g - b, rb = Math.abs(r - b);
      hit = gr > 25 && gb > 15 && rb < Math.max(r, b, 1) * 0.5;
    } else if (family === 'cyan') {
      const gr = g - r, br = b - r, gb = Math.abs(g - b);
      hit = gr > 20 && br > 20 && gb < Math.max(g, b, 1) * 0.45;
    }
    if (hit) {
      rgba[i + 3] = 0;
      keyed++;
    }
  }
  return keyed;
}

// Hex + English name for each supported family (used in prompts).
const CHROMA_PRESETS = {
  magenta: { hex: '#ff00ff', rgbText: '255, 0, 255', name: 'magenta' },
  green:   { hex: '#00ff00', rgbText: '0, 255, 0',   name: 'green'   },
  cyan:    { hex: '#00ffff', rgbText: '0, 255, 255', name: 'cyan'    },
};

// Choose key family: explicit manifest.chromaColor > inferred from character description > magenta default.
function resolveChromaFamily(manifest) {
  const explicit = (manifest.chromaColor || '').toLowerCase();
  if (CHROMA_PRESETS[explicit]) return explicit;
  const hay = ((manifest.assets || []).map(a => a.description || '').join(' ') + ' ' + (manifest.defaultStyle || '')).toLowerCase();
  // If the character uses purple/magenta/pink accents, keying magenta would eat them.
  if (/\b(purple|magenta|pink|violet)\b/.test(hay)) return 'green';
  // If character uses green, avoid green key.
  if (/\bgreen\b/.test(hay)) return 'magenta';
  return 'magenta';
}

const CHROMA_FAMILY = resolveChromaFamily(manifest);
const CHROMA = CHROMA_PRESETS[CHROMA_FAMILY];
console.log(`  Chroma:   ${CHROMA_FAMILY} (${CHROMA.hex})`);

// Count distinct horizontal content bands in a chroma-keyed RGBA buffer.
// Used to verify the model produced the requested row count.
function countContentRows(rgba, width, height) {
  const minRowAlpha = width * 30; // at least some alpha on this scanline
  const minBandHeight = Math.max(6, Math.floor(height * 0.04));
  // Gap between true rows is usually big; gaps inside a single figure are small.
  // 8% of height is a safe cutoff — bigger than any internal character gap.
  const minGapHeight = Math.max(12, Math.floor(height * 0.08));

  const filled = new Uint8Array(height);
  for (let y = 0; y < height; y++) {
    let sum = 0;
    const base = y * width * 4;
    for (let x = 0; x < width; x++) sum += rgba[base + x * 4 + 3];
    filled[y] = sum > minRowAlpha ? 1 : 0;
  }
  let bands = 0, inBand = false, bandLen = 0, gapLen = 0;
  for (let y = 0; y < height; y++) {
    if (filled[y]) {
      if (!inBand) {
        if (bands > 0 && gapLen < minGapHeight) { inBand = true; continue; } // merge near bands
        inBand = true; bandLen = 0;
      }
      bandLen++;
      gapLen = 0;
    } else {
      if (inBand) {
        gapLen = 1;
        inBand = false;
        if (bandLen >= minBandHeight) bands++;
      } else {
        gapLen++;
      }
    }
  }
  if (inBand && bandLen >= minBandHeight) bands++;
  return bands;
}

async function sliceSheet(pngBuffer, sheet) {
  const meta = await sharp(pngBuffer).metadata();
  // Convert entire sheet to raw RGBA, key magenta, re-encode once.
  const { data, info } = await sharp(pngBuffer)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const keyedCount = chromaKey(data, CHROMA_FAMILY);
  const detectedRows = countContentRows(data, info.width, info.height);
  console.log(`    chroma-keyed ${keyedCount} / ${data.length / 4} pixels, detected ${detectedRows} content row(s) vs expected ${sheet.rows}`);
  const keyed = await sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } })
    .png()
    .toBuffer();

  const cellW = Math.floor(info.width / sheet.cols);
  const cellH = Math.floor(info.height / sheet.rows);

  for (const cell of sheet.cells) {
    const categoryDir = path.join(outputDir, cell.asset.category || 'misc');
    fs.mkdirSync(categoryDir, { recursive: true });
    const outPath = path.join(categoryDir, `${cell.asset.id}.png`);
    await sharp(keyed)
      .extract({ left: cell.col * cellW, top: cell.row * cellH, width: cellW, height: cellH })
      .resize(CELL, CELL, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png()
      .toFile(outPath);
  }

  // Save the raw + keyed sheets for inspection.
  const baseName = sheet.key.replace(/[^a-zA-Z0-9._-]+/g, '_');
  const sheetDir = path.join(outputDir, '_sheets');
  fs.mkdirSync(sheetDir, { recursive: true });
  const rawPath = path.join(sheetDir, `${baseName}.raw.png`);
  const keyedPath = path.join(sheetDir, `${baseName}.keyed.png`);
  fs.writeFileSync(rawPath, pngBuffer);
  fs.writeFileSync(keyedPath, keyed);
  return { rawPath, keyedPath, detectedRows };
}

// Project a multi-row sheet spec into N single-row sheets (one per direction).
// Each sub-sheet keeps the same asset references so outputs still land at the
// correct per-frame paths.
function splitSheetByDirection(sheet) {
  return sheet.rowDirs.map((dir, i) => {
    const rowCells = sheet.cells
      .filter(c => c.row === i)
      .map(c => ({ ...c, row: 0 })); // renumber to row 0 of the sub-sheet
    return {
      key: `${sheet.key}::${dir}`,
      category: sheet.category,
      action: sheet.action,
      rows: 1,
      cols: rowCells.length,
      rowDirs: [dir],
      cells: rowCells,
    };
  });
}

// ---------------------------------------------------------------------------
// Call Gemini 2.5 Flash Image for a single sheet, with basic retry.
// ---------------------------------------------------------------------------
async function generateHero(seedAsset) {
  const prompt = buildHeroPrompt(manifest, seedAsset);
  const response = await genai.models.generateContent({
    model: args.model,
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    config: { imageConfig: { aspectRatio: '1:1' } },
  });
  const parts = response?.candidates?.[0]?.content?.parts || [];
  const imgPart = parts.find(p => p.inlineData?.data);
  if (!imgPart) throw new Error('No image in hero response');
  return {
    bytesB64: imgPart.inlineData.data,
    mimeType: imgPart.inlineData.mimeType || 'image/png',
  };
}

async function generateSheet(sheet, hero, retries = 2) {
  const prompt = buildSheetPrompt(sheet, manifest, { hasReference: !!hero });

  if (args['skip-existing']) {
    const allExist = sheet.cells.every(c => {
      const p = path.join(outputDir, c.asset.category || 'misc', `${c.asset.id}.png`);
      return fs.existsSync(p);
    });
    if (allExist) return { key: sheet.key, status: 'skipped' };
  }

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const aspect = pickAspect(sheet.cols, sheet.rows);
      const parts = [{ text: prompt }];
      if (hero) {
        parts.push({ inlineData: { mimeType: hero.mimeType, data: hero.bytesB64 } });
      }
      const response = await genai.models.generateContent({
        model: args.model,
        contents: [{ role: 'user', parts }],
        config: { imageConfig: { aspectRatio: aspect } },
      });

      const respParts = response?.candidates?.[0]?.content?.parts || [];
      const imgPart = respParts.find(p => p.inlineData?.data);
      if (!imgPart) throw new Error('No image in response');

      const buffer = Buffer.from(imgPart.inlineData.data, 'base64');
      const sliceResult = await sliceSheet(buffer, sheet);
      return {
        key: sheet.key,
        status: 'ok',
        sheetPath: sliceResult.keyedPath,
        detectedRows: sliceResult.detectedRows,
        rowsMatch: sliceResult.detectedRows === sheet.rows,
        frames: sheet.cells.length,
      };
    } catch (err) {
      if (attempt < retries) {
        const wait = Math.pow(2, attempt + 1) * 1000;
        console.warn(`  Retry ${attempt + 1}/${retries} for ${sheet.key} in ${wait / 1000}s (${err.message})`);
        await new Promise(r => setTimeout(r, wait));
        continue;
      }
      return { key: sheet.key, status: 'error', error: err.message };
    }
  }
}

// ---------------------------------------------------------------------------
// Run sheets serially (they're cheap and few; avoids rate limits).
// ---------------------------------------------------------------------------
const start = Date.now();
const results = [];

// Generate a hero reference frame from the first asset of the first sheet.
// All sheets in this run use it as an identity anchor.
let hero = null;
if (targetSheets.length > 0) {
  const seed = targetSheets[0].cells[0].asset;
  console.log(`\nGenerating hero reference frame from ${seed.id}...`);
  try {
    hero = await generateHero(seed);
    const heroPath = path.join(outputDir, '_sheets', '_hero.png');
    fs.mkdirSync(path.dirname(heroPath), { recursive: true });
    fs.writeFileSync(heroPath, Buffer.from(hero.bytesB64, 'base64'));
    console.log(`  ✓ hero saved to ${heroPath}`);
  } catch (err) {
    console.warn(`  ✗ hero generation failed (${err.message}) — continuing without reference`);
  }
}

const strategy = args.strategy;
console.log(`\nStrategy: ${strategy}\n`);

async function runSheetWithStrategy(s) {
  // per-direction: always split multi-row sheets into 1xN strips.
  if (strategy === 'per-direction' && s.rows > 1) {
    const subs = splitSheetByDirection(s);
    console.log(`  Splitting into ${subs.length} per-direction strip(s).`);
    const subResults = [];
    for (const sub of subs) {
      console.log(`    → ${sub.key} (1x${sub.cols})...`);
      const r = await generateSheet(sub, hero);
      if (r.status === 'ok') console.log(`      ✓ ${r.frames} frames`);
      else console.log(`      ✗ ${r.error || 'skipped'}`);
      subResults.push(r);
    }
    const failed = subResults.filter(r => r.status === 'error').length;
    return {
      key: s.key,
      status: failed > 0 ? 'error' : 'ok',
      frames: s.cells.length,
      strategy: 'per-direction',
      subResults,
    };
  }

  // multi-row or auto: try the full sheet first.
  const r = await generateSheet(s, hero);
  if (r.status !== 'ok') return { ...r, strategy: 'multi-row' };

  // auto: if rows don't match expected, fall back to per-direction.
  if (strategy === 'auto' && s.rows > 1 && !r.rowsMatch) {
    console.log(`  Row count mismatch (${r.detectedRows}/${s.rows}) — falling back to per-direction.`);
    const subs = splitSheetByDirection(s);
    const subResults = [];
    for (const sub of subs) {
      console.log(`    → ${sub.key} (1x${sub.cols})...`);
      const sr = await generateSheet(sub, hero);
      if (sr.status === 'ok') console.log(`      ✓ ${sr.frames} frames`);
      else console.log(`      ✗ ${sr.error || 'skipped'}`);
      subResults.push(sr);
    }
    const failed = subResults.filter(x => x.status === 'error').length;
    return {
      key: s.key,
      status: failed > 0 ? 'error' : 'ok',
      frames: s.cells.length,
      strategy: 'auto-fallback',
      subResults,
    };
  }

  return { ...r, strategy: 'multi-row' };
}

for (let i = 0; i < targetSheets.length; i++) {
  const s = targetSheets[i];
  console.log(`\n[${i + 1}/${targetSheets.length}] ${s.key} (${s.rows}x${s.cols})...`);
  const r = await runSheetWithStrategy(s);
  if (r.status === 'ok') console.log(`  ✓ ${r.frames} frames done via ${r.strategy}`);
  else if (r.status === 'skipped') console.log(`  ↷ skipped`);
  else console.log(`  ✗ ${r.error || 'failed'}`);
  results.push(r);
}

const elapsed = ((Date.now() - start) / 1000).toFixed(1);
const ok = results.filter(r => r.status === 'ok').length;
const skipped = results.filter(r => r.status === 'skipped').length;
const failed = results.filter(r => r.status === 'error').length;
console.log(`\nDone in ${elapsed}s — ${ok} ok, ${skipped} skipped, ${failed} failed.`);

const logPath = path.join(outputDir, 'sheet-generation-log.json');
fs.writeFileSync(logPath, JSON.stringify({ timestamp: new Date().toISOString(), results }, null, 2));
if (failed > 0) process.exit(1);
