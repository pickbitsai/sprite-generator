/**
 * Verify character select screen rendering for a theme.
 *
 * Boots the game in Playwright, goes to the select screen, and for each
 * character:
 *   1. Verifies the idle sprite renders with non-trivial opaque content
 *   2. Takes multiple frames and checks center-of-mass stability (no drift)
 *
 * Also works without a theme (pass "base" or omit) to verify the base game.
 *
 * Usage:
 *   node tools/theme/verify-character-select.js <theme-id|base>
 *   node tools/theme/verify-character-select.js <theme-id> --screenshots
 *
 * Exit code: 0 if all characters pass, 2 otherwise.
 */
const { chromium } = require('playwright-core');
const http = require('http');
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const ROOT = path.join(__dirname, '..', '..');
const PORT = 8774;
const MIME = { '.html':'text/html','.js':'text/javascript','.png':'image/png','.mp3':'audio/mp3' };

const MIN_OPAQUE_PX = 80;
const MAX_DRIFT_PX = 8; // max center-of-mass shift between idle frames
const IDLE_SAMPLE_FRAMES = 5; // number of idle frames to sample for drift

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  const p = path.join(ROOT, url === '/' ? 'index.html' : url);
  fs.readFile(p, (err, data) => {
    if (err) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(p)] || 'application/octet-stream' });
    res.end(data);
  });
});

async function analyseBuffer(buf) {
  const { data, info } = await sharp(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let n = 0, cx = 0, cy = 0;
  for (let y = 0; y < info.height; y++) {
    for (let x = 0; x < info.width; x++) {
      const a = data[(y * info.width + x) * info.channels + (info.channels - 1)];
      if (a > 30) { n++; cx += x; cy += y; }
    }
  }
  if (n === 0) return { opaque: 0, cx: 0, cy: 0, thumbBuf: null };
  // 32×32 thumbnail for perceptual similarity comparison
  const thumbBuf = await sharp(buf).resize(32, 32, { fit: 'fill' }).greyscale().raw().toBuffer();
  return { opaque: n, cx: cx / n, cy: cy / n, thumbBuf };
}

// Normalised cross-correlation between two 32×32 greyscale thumbnails.
// Returns 0..1 where 1 = identical, 0 = no correlation.
function ncc(a, b) {
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

async function main() {
  const args = process.argv.slice(2);
  const themeId = args.find(a => !a.startsWith('-')) || 'base';
  const isBase = themeId === 'base';
  const writeScreenshots = args.includes('--screenshots');
  fs.mkdirSync(path.join(ROOT, 'test-screenshots'), { recursive: true });

  await new Promise(r => server.listen(PORT, r));
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 960, height: 540 } });

  const pageErrors = [];
  page.on('pageerror', e => pageErrors.push(e.message));

  const url = isBase
    ? `http://localhost:${PORT}/index.html`
    : `http://localhost:${PORT}/index.html?theme=${themeId}`;
  console.log(`[verify-character-select] ${url}`);
  await page.goto(url);
  await page.waitForFunction(() => window.game && window.game.spritesReady, { timeout: 20000 });

  // Go to select screen
  await page.evaluate(() => {
    window.game.scene = 'select';
    window.game.selectedCharacter = 0;
  });
  await page.waitForTimeout(300);

  // Get character count
  const charCount = await page.evaluate(() => CHARACTERS.length);
  console.log(`  ${charCount} characters to verify`);

  const failures = [];

  for (let ci = 0; ci < charCount; ci++) {
    const charName = await page.evaluate((i) => CHARACTERS[i].name, ci);
    process.stdout.write(`  [${ci}] ${charName}: `);

    // Freeze game loop for deterministic rendering
    await page.evaluate(() => {
      window.game.__savedUpdate = window.game.update;
      window.game.update = () => {};
    });

    const centers = [];

    for (let frame = 0; frame < IDLE_SAMPLE_FRAMES; frame++) {
      // Set selected character and force a specific animation frame
      await page.evaluate(({ ci, frame }) => {
        const g = window.game;
        g.scene = 'select';
        g.selectedCharacter = ci;
        g.animFrame = frame * 12; // spread frames across idle cycle
        g.render();
      }, { ci, frame });

      // Crop the character preview area
      const rect = await page.evaluate((ci) => {
        const c = document.getElementById('gameCanvas');
        const cb = c.getBoundingClientRect();
        const spacing = 384 / 4;
        const cx = spacing * ci + spacing / 2;
        const scaleX = cb.width / 384;
        const scaleY = cb.height / 224;
        // Preview area: character is drawn at cy=90, extends up ~75px
        return {
          x: Math.round(cb.left + (cx - 40) * scaleX),
          y: Math.round(cb.top + 35 * scaleY),
          width: Math.round(80 * scaleX),
          height: Math.round(75 * scaleY),
        };
      }, ci);

      const buf = await page.screenshot({ clip: rect });
      const stats = await analyseBuffer(buf);
      centers.push(stats);

      if (writeScreenshots) {
        const out = path.join(ROOT, 'test-screenshots',
          `verify-select-${isBase ? 'base' : themeId}-${charName.replace(/\s+/g, '_')}-f${frame}.png`);
        fs.writeFileSync(out, buf);
      }
    }

    // Check 1: all frames have non-trivial opaque content
    const minOpaque = Math.min(...centers.map(c => c.opaque));
    if (minOpaque < MIN_OPAQUE_PX) {
      process.stdout.write(`FAIL (only ${minOpaque}px opaque)\n`);
      failures.push(`${charName}: only ${minOpaque}px opaque (need ${MIN_OPAQUE_PX})`);
      await page.evaluate(() => { window.game.update = window.game.__savedUpdate; });
      continue;
    }

    // Check 2: center-of-mass stability across frames
    const cxVals = centers.filter(c => c.opaque >= MIN_OPAQUE_PX).map(c => c.cx);
    const cyVals = centers.filter(c => c.opaque >= MIN_OPAQUE_PX).map(c => c.cy);
    const driftX = cxVals.length > 1 ? Math.max(...cxVals) - Math.min(...cxVals) : 0;
    const driftY = cyVals.length > 1 ? Math.max(...cyVals) - Math.min(...cyVals) : 0;
    const drift = Math.max(driftX, driftY);

    // Check 3: visual similarity — all idle frames should look like the same character.
    // Compare each frame's 32×32 greyscale thumbnail against frame 0 via NCC.
    const thumbs = centers.filter(c => c.thumbBuf).map(c => c.thumbBuf);
    let minSim = 1;
    if (thumbs.length > 1) {
      for (let i = 1; i < thumbs.length; i++) {
        const sim = ncc(thumbs[0], thumbs[i]);
        if (sim < minSim) minSim = sim;
      }
    }
    const MIN_SIMILARITY = 0.70; // NCC < 0.70 = visually different character

    if (drift > MAX_DRIFT_PX) {
      process.stdout.write(`FAIL (drift ${drift.toFixed(1)}px)\n`);
      failures.push(`${charName}: idle drift ${drift.toFixed(1)}px (max ${MAX_DRIFT_PX})`);
    } else if (minSim < MIN_SIMILARITY) {
      process.stdout.write(`FAIL (identity drift NCC=${minSim.toFixed(2)})\n`);
      failures.push(`${charName}: idle identity NCC ${minSim.toFixed(2)} (need ≥${MIN_SIMILARITY})`);
    } else {
      process.stdout.write(`OK (${minOpaque}px, drift ${drift.toFixed(1)}px, NCC ${minSim.toFixed(2)})\n`);
    }

    // Restore game loop
    await page.evaluate(() => { window.game.update = window.game.__savedUpdate; });
  }

  if (pageErrors.length) {
    console.log(`\n  JS errors: ${pageErrors.join('; ')}`);
  }

  await browser.close();
  server.close();

  if (failures.length) {
    console.log(`\nFAILED: ${failures.length} character(s)`);
    failures.forEach(f => console.log(`  - ${f}`));
    process.exit(2);
  }
  console.log('\nAll characters passed.');
}

main().catch(e => { console.error(e); process.exit(1); });
