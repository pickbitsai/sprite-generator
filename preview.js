#!/usr/bin/env node
/**
 * Preview Server - generates a simple HTML page showing all generated sprites
 *
 * Usage: node preview.js [--output ./output] [--port 3333]
 */

import fs from 'fs';
import path from 'path';
import http from 'http';
import { parseArgs } from 'util';

const { values: args } = parseArgs({
  options: {
    output: { type: 'string', default: './output' },
    port:   { type: 'string', default: '3333' },
    manifest: { type: 'string', default: './manifest.json' },
  },
  strict: false,
});

const outputDir = path.resolve(args.output);
const port = parseInt(args.port, 10);
const manifest = JSON.parse(fs.readFileSync(path.resolve(args.manifest), 'utf-8'));

function findPngs(dir, base = '') {
  const results = [];
  if (!fs.existsSync(dir)) return results;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = path.join(base, entry.name);
    if (entry.isDirectory()) {
      results.push(...findPngs(path.join(dir, entry.name), rel));
    } else if (entry.name.endsWith('.png')) {
      results.push(rel);
    }
  }
  return results;
}

function buildHtml() {
  const pngs = findPngs(outputDir);
  const assetMap = new Map((manifest.assets || []).map(a => [a.id, a]));

  // Group by category (directory)
  const groups = {};
  for (const p of pngs) {
    const parts = p.split(path.sep);
    const category = parts.length > 1 ? parts[0] : 'misc';
    const id = path.basename(p, '.png');
    if (!groups[category]) groups[category] = [];
    const asset = assetMap.get(id);
    groups[category].push({ path: p, id, asset });
  }

  let html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Sprite Preview</title>
<style>
  body { background: #1a1a2e; color: #eee; font-family: system-ui; padding: 20px; }
  h1 { color: #c084fc; }
  h2 { color: #a855f7; border-bottom: 1px solid #333; padding-bottom: 4px; margin-top: 32px; }
  .grid { display: flex; flex-wrap: wrap; gap: 16px; }
  .card { background: #12121a; border: 1px solid #333; border-radius: 8px; padding: 12px; text-align: center; width: 140px; }
  .card img { width: 96px; height: 96px; image-rendering: auto; }
  .card .name { font-size: 0.8rem; margin-top: 6px; }
  .card .emoji { font-size: 1.4rem; }
  .missing { opacity: 0.3; }
</style></head><body>
<h1>Sprite Preview</h1>
<p>${pngs.length} sprites generated</p>`;

  for (const [category, items] of Object.entries(groups).sort()) {
    html += `<h2>${category} (${items.length})</h2><div class="grid">`;
    for (const item of items.sort((a, b) => a.id.localeCompare(b.id))) {
      const emoji = item.asset?.emoji || '';
      html += `<div class="card">
        <img src="/sprites/${item.path}" alt="${item.id}">
        <div class="name">${item.asset?.name || item.id}</div>
        <div class="emoji">${emoji}</div>
      </div>`;
    }
    html += '</div>';
  }

  // Show missing assets
  const generated = new Set(pngs.map(p => path.basename(p, '.png')));
  const missing = (manifest.assets || []).filter(a => !generated.has(a.id));
  if (missing.length > 0) {
    html += `<h2>Missing (${missing.length})</h2><div class="grid">`;
    for (const a of missing) {
      html += `<div class="card missing">
        <div class="emoji" style="font-size:3rem">${a.emoji}</div>
        <div class="name">${a.name}</div>
      </div>`;
    }
    html += '</div>';
  }

  html += '</body></html>';
  return html;
}

const server = http.createServer((req, res) => {
  if (req.url.startsWith('/sprites/')) {
    const filePath = path.join(outputDir, req.url.replace('/sprites/', ''));
    if (fs.existsSync(filePath)) {
      res.writeHead(200, { 'Content-Type': 'image/png' });
      fs.createReadStream(filePath).pipe(res);
      return;
    }
  }
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(buildHtml());
});

server.listen(port, () => {
  console.log(`Sprite preview: http://localhost:${port}`);
});
