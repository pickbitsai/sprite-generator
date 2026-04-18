/**
 * Stitch every per-asset review grid (walks + enemies + bosses + pickups +
 * backgrounds) into a single tall PNG with section headers. This is the
 * one file you need to eyeball to approve or reject a theme run — if
 * anything in it looks wrong, the theme doesn't ship.
 *
 * Runs LAST in the pipeline, after the individual capture stages have
 * already produced their grids. If a grid file is missing, the section
 * shows a "MISSING: <file>" placeholder so the reviewer knows.
 *
 * Usage:
 *   node tools/theme/capture-review-sheet.js            # base
 *   node tools/theme/capture-review-sheet.js simpsons
 *
 * Output:
 *   test-screenshots/review-<theme|base>-sheet.png
 */
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const ROOT = path.join(__dirname, '..', '..');

const SECTIONS = [
  { title: 'Walks (2-frame cycle)', file: (label) => `walks-${label}-strip.png` },
  { title: 'Character moves (every state × every frame)', file: (label) => `character-moves-${label}-grid.png` },
  { title: 'Enemies',               file: (label) => `enemies-${label}-grid.png` },
  { title: 'Bosses',                file: (label) => `bosses-${label}-grid.png` },
  { title: 'Pickups',               file: (label) => `pickups-${label}-grid.png` },
  { title: 'Backgrounds',           file: (label) => `backgrounds-${label}-grid.png` },
];

async function main() {
  const themeId = process.argv[2] || '';
  const label = themeId || 'base';
  const outDir = path.join(ROOT, 'test-screenshots');
  fs.mkdirSync(outDir, { recursive: true });

  // Load each grid's dimensions first so we can lay out the composite.
  const loaded = [];
  const MAX_W = 1240;   // scale every section to this width for uniform columns
  const HEADER_H = 40;
  const GAP = 12;

  let totalH = GAP;
  for (const s of SECTIONS) {
    const p = path.join(outDir, s.file(label));
    if (!fs.existsSync(p)) {
      loaded.push({ ...s, path: p, missing: true, w: MAX_W, h: 80 });
      totalH += HEADER_H + 80 + GAP;
      continue;
    }
    const m = await sharp(p).metadata();
    // Scale to fit MAX_W, preserving aspect.
    const scale = m.width > MAX_W ? MAX_W / m.width : 1;
    const w = Math.round(m.width * scale);
    const h = Math.round(m.height * scale);
    loaded.push({ ...s, path: p, missing: false, w, h });
    totalH += HEADER_H + h + GAP;
  }
  const totalW = MAX_W + 2 * GAP;

  const composites = [];
  let y = GAP;
  for (const s of loaded) {
    const headerSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="${MAX_W}" height="${HEADER_H}"><rect width="100%" height="100%" fill="#2b2b3a"/><text x="14" y="${Math.floor(HEADER_H * 0.66)}" font-family="monospace" font-size="20" fill="#ffcc66" font-weight="bold">${s.title}${s.missing ? '  — MISSING' : ''}</text></svg>`;
    composites.push({ input: await sharp(Buffer.from(headerSvg)).png().toBuffer(), top: y, left: GAP });
    y += HEADER_H;
    if (s.missing) {
      const placeholder = `<svg xmlns="http://www.w3.org/2000/svg" width="${MAX_W}" height="${s.h}"><rect width="100%" height="100%" fill="#2a1010"/><text x="14" y="${Math.floor(s.h/2) + 4}" font-family="monospace" font-size="14" fill="#ff8888">missing: ${path.basename(s.path)} — run the matching capture stage</text></svg>`;
      composites.push({ input: await sharp(Buffer.from(placeholder)).png().toBuffer(), top: y, left: GAP });
    } else {
      const buf = await sharp(s.path).resize(s.w, s.h, { fit: 'contain', background: '#12121a' }).png().toBuffer();
      composites.push({ input: buf, top: y, left: GAP });
    }
    y += s.h + GAP;
  }

  const reviewPath = path.join(outDir, `review-${label}-sheet.png`);
  await sharp({ create: { width: totalW, height: totalH, channels: 4, background: '#0a0a12' } })
    .composite(composites).png().toFile(reviewPath);

  const missing = loaded.filter(s => s.missing);
  if (missing.length) {
    console.log(`[capture-review-sheet] WARNING — ${missing.length} section(s) missing (filenames shown in sheet):`);
    for (const m of missing) console.log(`  ${path.basename(m.path)}`);
  }
  console.log(`[capture-review-sheet] → ${path.relative(ROOT, reviewPath)}`);
}

main().catch(e => { console.error('[capture-review-sheet] CRASHED:', e.message); process.exit(1); });
