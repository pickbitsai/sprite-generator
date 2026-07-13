/**
 * Background removal for AI-generated sprite frames.
 *
 * AI image generators (Imagen 4, GPT-image-1) ignore "transparent background"
 * prompts and return frames on solid white or colored backgrounds. This module
 * flood-fills from the image border to remove the background color, preserving
 * interior regions of the same color (e.g. white highlights on the character).
 *
 * Usage:
 *   import { cleanBackground } from './lib/clean-bg.js';
 *   await cleanBackground('input.png', 'output.png');
 */
import sharp from 'sharp';
import fs from 'fs';

/**
 * Buffer-friendly variant — accepts a PNG buffer and returns a cleaned PNG
 * buffer without touching the filesystem. Used by the pack pipeline.
 *
 * @param {Buffer} inputBuf
 * @param {object} opts
 * @param {number} opts.threshold - Color distance threshold (default: 60)
 * @returns {Buffer} cleaned PNG buffer (or the original if corners are already transparent)
 */
export async function cleanBackgroundBuffer(inputBuf, opts = {}) {
  const threshold = opts.threshold ?? 60;
  const { data, info } = await sharp(inputBuf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const w = info.width, h = info.height, ch = info.channels;
  const px = Buffer.from(data);
  const cleaned = floodFillBg(px, w, h, ch, threshold);
  if (!cleaned) return inputBuf;
  return await sharp(px, { raw: { width: w, height: h, channels: ch } }).png().toBuffer();
}

function floodFillBg(px, w, h, ch, threshold) {
  const idx = (x, y) => (y * w + x) * ch;
  const corners = [[0, 0], [w - 1, 0], [0, h - 1], [w - 1, h - 1]];
  let br = 0, bg = 0, bb = 0, count = 0;
  for (const [x, y] of corners) {
    const i = idx(x, y);
    if (px[i + 3] > 200) { br += px[i]; bg += px[i + 1]; bb += px[i + 2]; count++; }
  }
  if (count < 2) return false; // corners already transparent
  br /= count; bg /= count; bb /= count;

  const t2 = threshold * threshold;
  const visited = new Uint8Array(w * h);
  const stack = [];
  for (let x = 0; x < w; x++) { stack.push(x, 0); stack.push(x, h - 1); }
  for (let y = 1; y < h - 1; y++) { stack.push(0, y); stack.push(w - 1, y); }
  while (stack.length) {
    const y = stack.pop(), x = stack.pop();
    if (x < 0 || x >= w || y < 0 || y >= h) continue;
    const v = y * w + x;
    if (visited[v]) continue;
    const i = v * ch;
    if (px[i + 3] < 30) { visited[v] = 1; continue; }
    const dr = px[i] - br, dg = px[i + 1] - bg, db = px[i + 2] - bb;
    if (dr * dr + dg * dg + db * db > t2) continue;
    visited[v] = 1;
    px[i + 3] = 0;
    stack.push(x + 1, y, x - 1, y, x, y + 1, x, y - 1);
  }
  return true;
}

/**
 * Remove background by flood-filling from corners.
 *
 * @param {string} inputPath  - Source image
 * @param {string} outputPath - Destination (can be same as input)
 * @param {object} opts
 * @param {number} opts.threshold - Color distance threshold (default: 60)
 */
export async function cleanBackground(inputPath, outputPath, opts = {}) {
  const threshold = opts.threshold ?? 60;
  const buf = fs.readFileSync(inputPath);
  const { data, info } = await sharp(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const w = info.width, h = info.height, ch = info.channels;
  const px = Buffer.from(data); // mutable copy

  const idx = (x, y) => (y * w + x) * ch;

  // Sample corners to get background color
  const corners = [[0, 0], [w - 1, 0], [0, h - 1], [w - 1, h - 1]];
  let br = 0, bg = 0, bb = 0, count = 0;
  for (const [x, y] of corners) {
    const i = idx(x, y);
    if (px[i + 3] > 200) { // opaque corner
      br += px[i]; bg += px[i + 1]; bb += px[i + 2];
      count++;
    }
  }
  if (count < 2) {
    // Already transparent or semi-transparent corners — nothing to clean
    return;
  }
  br /= count; bg /= count; bb /= count;

  // BFS flood-fill from all border pixels that match the background color
  const t2 = threshold * threshold;
  const visited = new Uint8Array(w * h);
  const stack = [];

  // Seed with all border pixels
  for (let x = 0; x < w; x++) { stack.push(x, 0); stack.push(x, h - 1); }
  for (let y = 1; y < h - 1; y++) { stack.push(0, y); stack.push(w - 1, y); }

  while (stack.length) {
    const y = stack.pop(), x = stack.pop();
    if (x < 0 || x >= w || y < 0 || y >= h) continue;
    const v = y * w + x;
    if (visited[v]) continue;
    const i = v * ch;
    if (px[i + 3] < 30) { visited[v] = 1; continue; } // already transparent
    const dr = px[i] - br, dg = px[i + 1] - bg, db = px[i + 2] - bb;
    if (dr * dr + dg * dg + db * db > t2) continue; // not background color
    visited[v] = 1;
    px[i + 3] = 0; // make transparent
    stack.push(x + 1, y, x - 1, y, x, y + 1, x, y - 1);
  }

  await sharp(px, { raw: { width: w, height: h, channels: ch } })
    .png()
    .toFile(outputPath);
}
