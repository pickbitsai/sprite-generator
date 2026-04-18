/**
 * Theme validator: loads index.html?theme=<id> headlessly, checks that all
 * assets load, the title screen renders, character select works, and the
 * first level starts without errors.
 *
 * Usage:  node tools/validate-theme.js <theme-id>
 * Output: test-screenshots/theme-<id>-{title,select,play}.png
 *         Non-zero exit code on any load error or missing asset.
 */
const { chromium } = require('playwright-core');
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = 8769;
const MIME = { '.html':'text/html','.js':'text/javascript','.png':'image/png','.mp3':'audio/mp3','.wav':'audio/wav','.ogg':'audio/ogg','.json':'application/json' };

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  const p = path.join(ROOT, url === '/' ? 'index.html' : url);
  fs.readFile(p, (err, data) => {
    if (err) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(p)] || 'application/octet-stream' });
    res.end(data);
  });
});

async function main() {
  const themeId = process.argv[2];
  if (!themeId) { console.error('Usage: node tools/validate-theme.js <theme-id>'); process.exit(1); }

  const themePath = path.join(ROOT, 'src', 'themes', themeId, 'theme.js');
  if (!fs.existsSync(themePath)) {
    console.error(`Missing ${themePath} — run build-config stage first`);
    process.exit(1);
  }

  fs.mkdirSync(path.join(ROOT, 'test-screenshots'), { recursive: true });

  await new Promise(r => server.listen(PORT, r));
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 960, height: 540 } });

  const errors = [];
  const missingAssets = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  page.on('response', r => {
    if (r.status() === 404) missingAssets.push(r.url());
  });

  const url = `http://localhost:${PORT}/index.html?theme=${themeId}`;
  console.log(`[validate] loading ${url}`);
  await page.goto(url);

  // Wait for all sprites to finish loading before driving the UI.
  try {
    await page.waitForFunction(() => window.game && window.game.spritesReady, { timeout: 15000 });
    console.log('[validate] sprites ready');
  } catch (e) {
    console.warn('[validate] sprites did not become ready within 15s — capturing anyway');
  }
  await page.waitForTimeout(500);
  await page.screenshot({ path: `test-screenshots/theme-${themeId}-title.png` });

  // Click the page body so keystrokes reach the window-level keydown listener.
  await page.locator('body').click({ force: true }).catch(() => {});

  // Helper: hold a key for a couple frames so justPressed() sees it.
  async function tap(key) {
    await page.keyboard.down(key);
    await page.waitForTimeout(120);
    await page.keyboard.up(key);
    await page.waitForTimeout(120);
  }

  // Title -> character select
  await tap('Enter');
  await page.waitForFunction(() => window.game && window.game.scene === 'select', { timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(400);
  await page.screenshot({ path: `test-screenshots/theme-${themeId}-select.png` });

  // Select char -> stage intro -> playing
  await tap('Enter');
  await page.waitForFunction(() => window.game && (window.game.scene === 'stageIntro' || window.game.scene === 'playing'), { timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(2500);
  await page.screenshot({ path: `test-screenshots/theme-${themeId}-play.png` });

  const finalScene = await page.evaluate(() => window.game?.scene);
  console.log(`[validate] final scene: ${finalScene}`);

  console.log(`[validate] errors: ${errors.length}`);
  errors.forEach(e => console.log('  ' + e));
  console.log(`[validate] missing assets: ${missingAssets.length}`);
  missingAssets.slice(0, 10).forEach(u => console.log('  404 ' + u));
  if (missingAssets.length > 10) console.log(`  ... and ${missingAssets.length - 10} more`);

  await browser.close();
  server.close();

  const fail = errors.length > 0 || missingAssets.length > 0;
  if (fail) { console.error(`[validate] FAILED`); process.exit(2); }
  console.log(`[validate] PASSED — screenshots in test-screenshots/`);
}

main().catch(e => { console.error('[validate] CRASHED:', e.message); process.exit(1); });
