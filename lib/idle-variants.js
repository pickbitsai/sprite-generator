/**
 * Programmatic idle animation variants.
 *
 * Generates N idle frames from a single source image by applying sub-pixel
 * vertical shifts (breathing bob). This is the technique 16-bit beat-em-ups
 * used — zero identity drift, zero API cost for frames 2+.
 *
 * Usage:
 *   import { generateIdleVariants } from './lib/idle-variants.js';
 *   await generateIdleVariants('idle_1.png', 'output/', 4);
 *   // Creates idle_1.png (copy), idle_2.png (-2px), idle_3.png (0px), idle_4.png (+1px)
 */
import sharp from 'sharp';
import fs from 'fs';
import path from 'path';

// Default breathing bob pattern: [frame1, frame2, frame3, frame4] pixel offsets
const DEFAULT_BOB = [0, -2, 0, 1];

/**
 * @param {string} sourcePath - Path to the base idle frame (frame 1)
 * @param {string} outputDir  - Directory to write variant PNGs
 * @param {number} count      - Total frames to produce (including source)
 * @param {string} prefix     - Filename prefix (default: 'idle')
 * @param {number[]} offsets  - Per-frame vertical offsets (default: DEFAULT_BOB)
 * @returns {string[]} Paths of all generated files
 */
export async function generateIdleVariants(sourcePath, outputDir, count = 4, prefix = 'idle', offsets = DEFAULT_BOB) {
  fs.mkdirSync(outputDir, { recursive: true });

  const srcBuf = fs.readFileSync(sourcePath);
  const meta = await sharp(srcBuf).metadata();
  const w = meta.width, h = meta.height;
  const paths = [];

  for (let f = 0; f < count; f++) {
    const out = path.join(outputDir, `${prefix}_${f + 1}.png`);
    const dy = offsets[f] || 0;

    if (dy === 0 && f === 0) {
      // Frame 1: just copy the source
      fs.copyFileSync(sourcePath, out);
    } else {
      // Composite source onto a blank canvas shifted by dy pixels
      const shifted = await sharp({
        create: { width: w, height: h, channels: 4,
                  background: { r: 0, g: 0, b: 0, alpha: 0 } }
      })
      .composite([{ input: srcBuf, top: dy, left: 0 }])
      .png()
      .toBuffer();
      fs.writeFileSync(out, shifted);
    }
    paths.push(out);
  }

  return paths;
}

export { DEFAULT_BOB };
