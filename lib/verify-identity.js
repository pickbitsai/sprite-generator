/**
 * Visual identity verification for animation frames.
 *
 * Uses Normalised Cross-Correlation (NCC) on 32×32 greyscale thumbnails to
 * detect when animation frames have drifted to look like different characters.
 * NCC ≥ 0.70 = same character, < 0.70 = identity drift.
 *
 * Usage:
 *   import { verifyFrameIdentity } from './lib/verify-identity.js';
 *   const result = await verifyFrameIdentity(['idle_1.png', 'idle_2.png', ...]);
 *   if (!result.pass) console.log(result.failures);
 */
import sharp from 'sharp';
import fs from 'fs';

const THUMB_SIZE = 32;
const DEFAULT_THRESHOLD = 0.70;

/**
 * Compute 32×32 greyscale thumbnail for NCC comparison.
 */
async function thumbnail(input) {
  const buf = Buffer.isBuffer(input) ? input : fs.readFileSync(input);
  return sharp(buf)
    .resize(THUMB_SIZE, THUMB_SIZE, { fit: 'fill' })
    .greyscale()
    .raw()
    .toBuffer();
}

/**
 * Normalised Cross-Correlation between two greyscale buffers.
 * Returns 0..1 where 1 = identical, 0 = no correlation.
 */
export function ncc(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  const n = a.length;
  let sumA = 0, sumB = 0;
  for (let i = 0; i < n; i++) { sumA += a[i]; sumB += b[i]; }
  const meanA = sumA / n, meanB = sumB / n;
  let num = 0, denA = 0, denB = 0;
  for (let i = 0; i < n; i++) {
    const da = a[i] - meanA, db = b[i] - meanB;
    num += da * db; denA += da * da; denB += db * db;
  }
  const den = Math.sqrt(denA * denB);
  return den === 0 ? 0 : num / den;
}

/**
 * Count opaque pixels and compute center-of-mass.
 */
export async function analyseFrame(input) {
  const buf = Buffer.isBuffer(input) ? input : fs.readFileSync(input);
  const { data, info } = await sharp(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let n = 0, cx = 0, cy = 0;
  for (let y = 0; y < info.height; y++) {
    for (let x = 0; x < info.width; x++) {
      const a = data[(y * info.width + x) * info.channels + (info.channels - 1)];
      if (a > 30) { n++; cx += x; cy += y; }
    }
  }
  const thumb = await thumbnail(buf);
  return {
    opaque: n,
    cx: n > 0 ? cx / n : 0,
    cy: n > 0 ? cy / n : 0,
    thumb,
  };
}

/**
 * Verify that a set of animation frames all depict the same character.
 *
 * @param {string[]} framePaths - Paths to frame PNGs
 * @param {object} opts
 * @param {number} opts.minOpaque    - Minimum opaque pixels per frame (default: 80)
 * @param {number} opts.maxDrift     - Max center-of-mass shift in px (default: 8)
 * @param {number} opts.minSimilarity - Min NCC between frame 0 and others (default: 0.70)
 * @returns {{ pass: boolean, minNCC: number, maxDrift: number, failures: string[] }}
 */
export async function verifyFrameIdentity(framePaths, opts = {}) {
  const minOpaque = opts.minOpaque ?? 80;
  const maxDrift = opts.maxDrift ?? 8;
  const minSimilarity = opts.minSimilarity ?? DEFAULT_THRESHOLD;

  const analyses = await Promise.all(framePaths.map(p => analyseFrame(p)));
  const failures = [];

  // Check opaque content
  for (let i = 0; i < analyses.length; i++) {
    if (analyses[i].opaque < minOpaque) {
      failures.push(`Frame ${i}: only ${analyses[i].opaque}px opaque (need ${minOpaque})`);
    }
  }

  // Check spatial drift
  const valid = analyses.filter(a => a.opaque >= minOpaque);
  if (valid.length > 1) {
    const cxs = valid.map(a => a.cx), cys = valid.map(a => a.cy);
    const drift = Math.max(
      Math.max(...cxs) - Math.min(...cxs),
      Math.max(...cys) - Math.min(...cys)
    );
    if (drift > maxDrift) {
      failures.push(`Spatial drift ${drift.toFixed(1)}px (max ${maxDrift})`);
    }
  }

  // Check visual identity via NCC
  let minNCC = 1;
  if (valid.length > 1) {
    for (let i = 1; i < valid.length; i++) {
      const sim = ncc(valid[0].thumb, valid[i].thumb);
      if (sim < minNCC) minNCC = sim;
    }
    if (minNCC < minSimilarity) {
      failures.push(`Identity NCC ${minNCC.toFixed(2)} (need ≥${minSimilarity})`);
    }
  }

  return { pass: failures.length === 0, minNCC, failures };
}
