import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(__dirname, '..');

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.json': 'application/json',
};

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--output')     args.output = argv[++i];
    else if (a === '--port')  args.port   = parseInt(argv[++i], 10);
    else if (a === '--out')   args.out    = argv[++i];
    else if (a === '--wait')  args.wait   = parseInt(argv[++i], 10);
  }
  return args;
}

function safeJoin(root, p) {
  const full = path.normalize(path.join(root, p));
  if (!full.startsWith(root)) return null;
  return full;
}

/**
 * Capture a screenshot of a template's demo.html rendered with the given output dir.
 *
 * @param {object} opts
 * @param {string} opts.templateDir  Absolute path to the template dir (contains demo.html).
 * @param {{width:number,height:number}} [opts.viewport]  Viewport size. Default 480x720.
 * @param {string} [opts.selector]   CSS selector of element to screenshot. Default '#stage'.
 * @param {number} [opts.wait]       ms to wait after load before capturing. Default 1500.
 * @param {string[]} [opts.argv]     CLI args (defaults to process.argv.slice(2)).
 */
export async function captureDemo(opts) {
  const cli = parseArgs(opts.argv || process.argv.slice(2));
  const templateDir = path.resolve(opts.templateDir);
  const outputDir = path.resolve(cli.output || path.join(PACKAGE_ROOT, 'output'));
  const port = cli.port || (4500 + Math.floor(Math.random() * 500));
  const screenshotPath = path.resolve(cli.out || path.join(templateDir, 'screenshot.png'));
  const viewport = opts.viewport || { width: 480, height: 720 };
  const selector = opts.selector || '#stage';
  const waitMs = cli.wait ?? opts.wait ?? 1500;

  const server = http.createServer((req, res) => {
    const url = decodeURIComponent(req.url.split('?')[0]);
    let filePath;
    if (url.startsWith('/output/')) {
      filePath = safeJoin(outputDir, url.replace('/output/', ''));
    } else {
      filePath = safeJoin(templateDir, url === '/' ? '/demo.html' : url);
    }
    if (!filePath || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      res.writeHead(404); res.end('not found'); return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    fs.createReadStream(filePath).pipe(res);
  });

  await new Promise(r => server.listen(port, r));
  console.log(`Demo server on http://localhost:${port}/`);
  console.log(`Reading sprites from ${outputDir}`);

  let chromium;
  try {
    ({ chromium } = await import('playwright'));
  } catch {
    try { ({ chromium } = await import('playwright-core')); } catch {
      console.error('playwright or playwright-core not installed. Install with: npm i -D playwright');
      server.close();
      process.exit(1);
    }
  }

  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 2 });
  const page = await ctx.newPage();

  const missing = [];
  page.on('response', r => { if (r.status() === 404 && r.url().includes('/output/')) missing.push(r.url()); });

  await page.goto(`http://localhost:${port}/?output=/output`);
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(waitMs);

  await page.locator(selector).screenshot({ path: screenshotPath });
  console.log(`Saved ${screenshotPath}`);

  if (missing.length) {
    console.warn(`\n${missing.length} sprite(s) missing — placeholder outlines shown in red:`);
    for (const u of missing) console.warn('  ' + u.replace(`http://localhost:${port}`, ''));
    console.warn(`Run sprite-generator against ${path.relative(PACKAGE_ROOT, templateDir)}/manifest.json to fill them in.`);
  }

  await browser.close();
  server.close();
}
