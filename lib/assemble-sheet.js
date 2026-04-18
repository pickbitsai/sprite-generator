/**
 * Sprite sheet assembly.
 *
 * Takes individual frame PNGs and packs them into a grid-based sprite sheet.
 * Each frame is tight-cropped, resized to fit within a cell (with configurable
 * margin), and centered. The output is a single PNG suitable for game engines.
 *
 * Usage:
 *   import { assembleSheet, resizeToCell } from './lib/assemble-sheet.js';
 *
 *   const cells = [
 *     { buf: await resizeToCell('idle_1.png', 256, 26), row: 0, col: 0 },
 *     { buf: await resizeToCell('idle_2.png', 256, 26), row: 0, col: 1 },
 *     ...
 *   ];
 *   const sheet = await assembleSheet(cells, 5, 8, 256); // 5 rows, 8 cols
 *   fs.writeFileSync('character.png', sheet);
 */
import sharp from 'sharp';

/**
 * Tight-crop a frame and resize it to fit within a cell with margin.
 *
 * @param {string|Buffer} input  - Path or buffer
 * @param {number} cellSize      - Cell dimension (e.g. 256)
 * @param {number} margin        - Transparent margin per side (e.g. 26)
 * @returns {Buffer} PNG buffer sized exactly cellSize × cellSize
 */
export async function resizeToCell(input, cellSize = 256, margin = null) {
  if (margin === null) margin = Math.round(cellSize * 0.10);
  const inner = cellSize - 2 * margin;

  // Tight-crop around actual opaque content
  const trimmed = await sharp(input).ensureAlpha().trim({ threshold: 10 }).toBuffer().catch(() => null);
  const base = trimmed || (Buffer.isBuffer(input) ? input : await sharp(input).toBuffer());

  return sharp(base)
    .resize(inner, inner, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .extend({
      top: margin, bottom: margin, left: margin, right: margin,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .png()
    .toBuffer();
}

/**
 * Assemble cells into a sprite sheet.
 *
 * @param {{ buf: Buffer, row: number, col: number }[]} cells
 * @param {number} rows
 * @param {number} cols
 * @param {number} cellSize
 * @returns {Buffer} PNG buffer of the assembled sheet
 */
export async function assembleSheet(cells, rows, cols, cellSize = 256) {
  const width = cellSize * cols;
  const height = cellSize * rows;
  const composite = cells.map(c => ({
    input: c.buf,
    top: c.row * cellSize,
    left: c.col * cellSize,
  }));
  return sharp({
    create: { width, height, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 0 } },
  }).composite(composite).png().toBuffer();
}
