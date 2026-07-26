/**
 * Game-pack pipeline: generate → auto-crop → fit-to-target → assemble → verify.
 *
 * Built for game projects whose engine code is tuned to specific frame
 * dimensions per asset (player walk-cycle hitboxes, tile placement, projectile
 * extraction, etc.). The AI returns 1024×1024 with characters at arbitrary
 * sizes and aspect ratios; this pipeline normalises every frame to the exact
 * `targetFrameWidth × targetFrameHeight` the engine expects, so the generated
 * sheet drops in without engine-side fix-ups.
 *
 * Spec shape (per asset):
 *   {
 *     id, name, description,
 *     frames: number,                     // poses laid out horizontally
 *     targetFrameWidth, targetFrameHeight,
 *     anchor?: 'bottom' | 'center' | 'top',  // vertical content alignment in cell (default 'bottom' for characters, 'center' for tiles/pickups/projectiles)
 *     layout?: 'character' | 'tiles' | 'pickups' | 'projectiles' | 'background',
 *     verifyIdentity?: boolean,           // NCC drift check on character frames
 *     transparent?: boolean,              // backgrounds set this false
 *     padding?: number                    // px padding inside each cell (default 4 for chars, 0 for bgs)
 *   }
 *
 * Pack manifest emitted to <output>/pack.json:
 *   { [id]: { file, frames, frameWidth, frameHeight, verification?: {...} } }
 */
import fs from 'fs';
import path from 'path';
import sharp from 'sharp';
import { verifyFrameIdentity } from './verify-identity.js';
import { cleanBackgroundBuffer } from './clean-bg.js';

const ALPHA_THRESHOLD = 30;
const MIN_GAP_PX = 5;

function buildPrompt(asset, defaultStyle) {
  const parts = [defaultStyle];
  if (asset.description) parts.push(asset.description);
  else parts.push(`A ${asset.name}`);
  if (asset.tags?.length) parts.push(`Keywords: ${asset.tags.join(', ')}`);
  return parts.join('. ') + '.';
}

// Edit-mode prompt: instructs the model to redraw the SAME entity from the
// reference image, only upgrading the rendering. This is what locks identity
// across the generated sheet — pure text-to-image lets the model invent a new
// character every call. Frame layout is also pinned by the reference (cells +
// poses already laid out left-to-right with transparent gaps).
function buildEditPrompt(asset, defaultStyle) {
  const frameCount = asset.frames || 1;
  const parts = [
    'Redraw the EXACT SAME character/object(s) from the reference image as a sprite sheet upgrade.',
    'Preserve identity rigorously: same silhouette, same body proportions, same color palette, same readable design language, same pose order across frames.',
    `Output EXACTLY ${frameCount} frame${frameCount === 1 ? '' : 's'} laid out left-to-right in a single row. No more, no fewer. Each frame separated by plain empty white space — DO NOT add panel borders, comic-strip dividers, frame outlines, vertical lines, or any visible separator between frames.`,
    'CRITICAL — background: paint a plain solid pure-white (#FFFFFF) background behind every frame and in the gaps between frames. Do NOT draw a checkerboard pattern. Do NOT draw a transparency-preview grid. Do NOT draw any other background color or scenery. Just plain white everywhere except the characters themselves. The pipeline strips white afterward to make it transparent.',
    `Upgrade only the rendering style to: ${defaultStyle}.`,
  ];
  if (asset.description) parts.push(`Frame layout: ${asset.description}`);
  if (asset.editPromptExtra) parts.push(asset.editPromptExtra);
  return parts.join(' ');
}

const VALID_SIZES = new Set(['1024x1024', '1024x1536', '1536x1024', 'auto']);

async function generateOne({ openai, model, size, prompt }) {
  if (!VALID_SIZES.has(size)) {
    throw new Error(`Invalid size "${size}" for ${model}. Use one of: ${[...VALID_SIZES].join(', ')}`);
  }
  const response = await openai.images.generate({ model, prompt, n: 1, size });
  let b64 = response.data[0].b64_json;
  if (!b64 && response.data[0].url) {
    const res = await fetch(response.data[0].url);
    b64 = Buffer.from(await res.arrayBuffer()).toString('base64');
  }
  if (!b64) throw new Error('No image bytes returned');
  return Buffer.from(b64, 'base64');
}

// Identity-locked generation via gpt-image-1's edit endpoint. Passes the
// reference image alongside the prompt so the model upgrades the existing
// entity instead of inventing a new one. Reference can be any size; output
// is rendered at the requested `size`.
async function generateOneEditOpenAI({ openai, model, size, referencePath, prompt }) {
  if (!VALID_SIZES.has(size)) {
    throw new Error(`Invalid size "${size}" for ${model}. Use one of: ${[...VALID_SIZES].join(', ')}`);
  }
  const stream = fs.createReadStream(referencePath);
  const response = await openai.images.edit({ model, image: stream, prompt, n: 1, size });
  let b64 = response.data[0].b64_json;
  if (!b64 && response.data[0].url) {
    const res = await fetch(response.data[0].url);
    b64 = Buffer.from(await res.arrayBuffer()).toString('base64');
  }
  if (!b64) throw new Error('No image bytes returned from edit');
  return Buffer.from(b64, 'base64');
}

// Identity-locked generation via Gemini 2.5 Flash Image ("Nano Banana"). Used
// when an OpenAI org has /images/generations gated to gpt-image-1 but
// /images/edits still locked to dall-e-2 — Gemini's image-edit endpoint
// accepts the reference + prompt and returns an upgraded image. Mirrors
// theme/lib.js callGeminiImageEdit. Output dimensions are not strictly
// honoured (Gemini decides), but the pack pipeline crops + rescales every
// asset to its target frame size downstream.
async function generateOneEditGemini({ apiKey, model, referencePath, prompt }) {
  // Flatten the reference to opaque white before sending. Gemini sometimes
  // reads transparent-PNG inputs as "draw a checkerboard transparency-preview
  // pattern in the background" and refuses to be talked out of it via prompt
  // alone. White is a neutral cue; the pipeline strips white from the output
  // downstream via cleanBackgroundBuffer.
  const refBuf = await sharp(fs.readFileSync(referencePath))
    .ensureAlpha()
    .flatten({ background: { r: 255, g: 255, b: 255 } })
    .png()
    .toBuffer();
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const body = {
    contents: [{
      parts: [
        { inline_data: { mime_type: 'image/png', data: refBuf.toString('base64') } },
        { text: prompt },
      ],
    }],
    generationConfig: { responseModalities: ['IMAGE'] },
  };
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error(`Gemini edit ${resp.status}: ${txt.slice(0, 300)}`);
  }
  const data = await resp.json();
  const parts = data.candidates?.[0]?.content?.parts || [];
  const imgPart = parts.find(p => p.inline_data || p.inlineData);
  const b64 = imgPart && (imgPart.inline_data?.data || imgPart.inlineData?.data);
  if (!b64) throw new Error('Gemini edit: no image in response');
  return Buffer.from(b64, 'base64');
}

/**
 * Auto-crop a horizontal sprite sheet into N frame bounding boxes.
 * Three-stage cascade:
 *   1. `gap`     — strict fully-empty column gaps. Best when generation left
 *                  visible whitespace between frames.
 *   2. `density` — column alpha-mass minima. Handles AI sheets where frames
 *                  touch or overlap slightly (no clean gap exists, but the
 *                  between-frame columns are still less dense than the
 *                  in-frame columns).
 *   3. `grid`    — even N-cell split. Last resort.
 */
async function detectFrameBoxes(buf, expectedFrames) {
  const img = sharp(buf).ensureAlpha();
  const { data, info } = await img.raw().toBuffer({ resolveWithObject: true });
  const { width: w, height: h, channels } = info;

  // Per-column alpha mass — high inside frames, low between them. Smoothed
  // so single-pixel artifacts (stray dots, anti-alias halos) don't fool the
  // minima search.
  const colMass = new Float32Array(w);
  for (let x = 0; x < w; x++) {
    let m = 0;
    for (let y = 0; y < h; y++) m += data[(y * w + x) * channels + 3];
    colMass[x] = m;
  }
  const smooth = new Float32Array(w);
  const SMOOTH_K = 3;
  for (let x = 0; x < w; x++) {
    let s = 0, n = 0;
    for (let dx = -SMOOTH_K; dx <= SMOOTH_K; dx++) {
      const xx = x + dx;
      if (xx >= 0 && xx < w) { s += colMass[xx]; n++; }
    }
    smooth[x] = s / n;
  }

  // === Stage 1: strict gap detection ===
  const colHasContent = new Uint8Array(w);
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) {
      if (data[(y * w + x) * channels + 3] > ALPHA_THRESHOLD) {
        colHasContent[x] = 1;
        break;
      }
    }
  }
  const regions = [];
  let inContent = false, start = 0;
  for (let x = 0; x < w; x++) {
    if (colHasContent[x] && !inContent) { start = x; inContent = true; }
    else if (!colHasContent[x] && inContent) {
      let gapEnd = x;
      while (gapEnd < w && !colHasContent[gapEnd]) gapEnd++;
      const gap = gapEnd - x;
      if (gap >= MIN_GAP_PX || gapEnd === w) {
        regions.push([start, x - 1]);
        inContent = false;
      }
    }
  }
  if (inContent) regions.push([start, w - 1]);

  let useGap = regions.length === expectedFrames;
  if (useGap) {
    const widths = regions.map(([s, e]) => e - s + 1);
    const sortedW = [...widths].sort((a, b) => a - b);
    const median = sortedW[Math.floor(sortedW.length / 2)];
    if (Math.max(...widths) > median * 2.5 || Math.min(...widths) < median * 0.1) {
      useGap = false;
    }
  }
  if (useGap) {
    const boxes = [];
    for (const [x1, x2] of regions) {
      const tight = await tightenBbox(data, w, h, channels, x1, 0, x2 + 1, h);
      if (tight) boxes.push(tight);
    }
    if (boxes.length === expectedFrames) return { boxes, source: 'gap' };
  }

  // === Stage 2: density-minima split ===
  // For each of the expectedFrames-1 boundary positions, search a window
  // around the ideal center (i * w/N) for the column with the lowest
  // smoothed mass and use that as the split. This handles touching frames
  // and frames whose silhouettes extend slightly into the gap.
  if (expectedFrames > 1) {
    const cellW = w / expectedFrames;
    const halfWin = Math.max(2, Math.floor(cellW * 0.35));
    const splits = [];
    for (let i = 1; i < expectedFrames; i++) {
      const center = Math.round(i * cellW);
      const lo = Math.max(0, center - halfWin);
      const hi = Math.min(w, center + halfWin);
      let bestX = center, bestM = Infinity;
      for (let x = lo; x < hi; x++) {
        if (smooth[x] < bestM) { bestM = smooth[x]; bestX = x; }
      }
      splits.push(bestX);
    }
    const densityRegions = [];
    let prev = 0;
    for (const s of splits) {
      densityRegions.push([prev, Math.max(prev, s - 1)]);
      prev = s + 1;
    }
    densityRegions.push([prev, w - 1]);

    const boxes = [];
    for (const [x1, x2] of densityRegions) {
      const tight = await tightenBbox(data, w, h, channels, x1, 0, x2 + 1, h);
      if (tight) boxes.push(tight);
    }
    if (boxes.length === expectedFrames) return { boxes, source: 'density' };
  }

  // === Stage 3: even grid (last resort) ===
  const boxes = [];
  const fw = Math.floor(w / expectedFrames);
  for (let i = 0; i < expectedFrames; i++) {
    const tight = await tightenBbox(data, w, h, channels, i * fw, 0, (i + 1) * fw, h);
    if (tight) boxes.push(tight);
  }
  return { boxes, source: 'grid' };
}

function tightenBbox(data, w, h, channels, x1, y1, x2, y2) {
  let minX = x2, minY = y2, maxX = x1 - 1, maxY = y1 - 1;
  for (let y = y1; y < y2; y++) {
    for (let x = x1; x < x2; x++) {
      if (data[(y * w + x) * channels + 3] > ALPHA_THRESHOLD) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < minX || maxY < minY) return null;
  return { left: minX, top: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

/**
 * Extract a frame from raw buffer, resize at the given uniform scale, and
 * place it in a transparent cell at the given anchor.
 *
 * Scale must be computed across ALL frames in a sheet (largest bbox) so each
 * pose keeps consistent on-screen proportions — without this, AI-generated
 * sheets where pose 1 is half the size of pose 4 produce a tiny player on
 * idle and a giant player on run.
 */
async function extractAtScale(rawBuf, box, scale, cellW, cellH, anchor, padding) {
  const targetW = Math.max(1, Math.round(box.width * scale));
  const targetH = Math.max(1, Math.round(box.height * scale));

  const cropped = await sharp(rawBuf)
    .ensureAlpha()
    .extract(box)
    .resize(targetW, targetH, { fit: 'fill' })
    .png()
    .toBuffer();

  let dx = Math.round((cellW - targetW) / 2);
  let dy;
  if (anchor === 'top') dy = padding;
  else if (anchor === 'bottom') dy = cellH - targetH - padding;
  else dy = Math.round((cellH - targetH) / 2);

  return sharp({
    create: { width: cellW, height: cellH, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .composite([{ input: cropped, top: Math.max(0, dy), left: Math.max(0, dx) }])
    .png()
    .toBuffer();
}

/**
 * Process a single raw 1024×1024 (or whatever) into a target sprite sheet.
 */
async function processAssetToSheet(rawPath, asset) {
  const rawDisk = fs.readFileSync(rawPath);
  const layout = asset.layout || (asset.frames > 1 ? 'character' : 'background');
  const isChar = layout === 'character';
  const anchor = asset.anchor || (layout === 'character' ? 'bottom' : 'center');
  const padding = asset.padding ?? (layout === 'background' ? 0 : 4);

  // gpt-image-1 ignores "transparent background" prompts and bakes in solid
  // white/light backgrounds. For everything but bgs, flood-fill from the
  // corners to reclaim transparency before bbox detection — otherwise the
  // crop step thinks the entire image is content.
  let rawBuf = rawDisk;
  if (layout !== 'background' && asset.cleanBg !== false) {
    try {
      rawBuf = await cleanBackgroundBuffer(rawDisk, { threshold: asset.bgThreshold ?? 60 });
    } catch {
      rawBuf = rawDisk;
    }
  }

  // Backgrounds: resize to target (cover preserves dramatic content for
  // landscape sources). When transparent: false, flatten any AI-introduced
  // alpha onto an opaque dark background so the final asset is solid.
  if (layout === 'background') {
    const tw = asset.targetFrameWidth, th = asset.targetFrameHeight;
    let pipe = sharp(rawBuf).ensureAlpha();
    if (tw && th) pipe = pipe.resize(tw, th, { fit: 'cover' });
    if (asset.transparent === false) {
      pipe = pipe.flatten({ background: asset.bgColor || { r: 8, g: 6, b: 18 } });
    }
    const out = await pipe.png().toBuffer();
    const meta = await sharp(out).metadata();
    return {
      buf: out,
      frameWidth: tw || meta.width,
      frameHeight: th || meta.height,
      verification: null,
    };
  }

  const { boxes, source } = await detectFrameBoxes(rawBuf, asset.frames);
  if (!boxes.length) throw new Error(`No frames detected in ${rawPath}`);

  const cellW = asset.targetFrameWidth;
  const cellH = asset.targetFrameHeight;
  if (!cellW || !cellH) throw new Error(`Asset "${asset.id}" missing targetFrameWidth/Height`);

  // Uniform scale across all frames so every pose keeps consistent on-screen
  // proportions. Fit the largest bbox into the inner cell.
  const innerW = Math.max(1, cellW - 2 * padding);
  const innerH = Math.max(1, cellH - 2 * padding);
  const maxBoxW = Math.max(...boxes.map(b => b.width));
  const maxBoxH = Math.max(...boxes.map(b => b.height));
  const scale = Math.min(innerW / maxBoxW, innerH / maxBoxH);

  const cellBufs = await Promise.all(
    boxes.map(b => extractAtScale(rawBuf, b, scale, cellW, cellH, anchor, padding))
  );
  // Pad with last frame if detection came back short
  while (cellBufs.length < asset.frames) cellBufs.push(cellBufs[cellBufs.length - 1]);

  const sheetW = cellW * asset.frames;
  const composite = cellBufs.map((buf, i) => ({ input: buf, top: 0, left: i * cellW }));
  const sheet = await sharp({
    create: { width: sheetW, height: cellH, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  }).composite(composite).png().toBuffer();

  let verification = null;
  if (asset.verifyIdentity && isChar && cellBufs.length > 1) {
    // Write cells to temp paths for the verifier (it expects file paths today)
    const tmpDir = fs.mkdtempSync(path.join(path.dirname(rawPath), `.verify-${asset.id}-`));
    const tmpPaths = await Promise.all(cellBufs.map(async (buf, i) => {
      const p = path.join(tmpDir, `${i}.png`);
      fs.writeFileSync(p, buf);
      return p;
    }));
    try {
      verification = await verifyFrameIdentity(tmpPaths);
    } finally {
      for (const p of tmpPaths) try { fs.unlinkSync(p); } catch {}
      try { fs.rmdirSync(tmpDir); } catch {}
    }
  }

  return { buf: sheet, frameWidth: cellW, frameHeight: cellH, source, verification };
}

/**
 * Run the full pack pipeline.
 *
 * @param {object} opts
 * @param {object} opts.spec        The game-pack spec object (loaded JSON)
 * @param {string} opts.outputDir   Directory to write final sheets + pack.json
 * @param {string} opts.rawDir      Where raws live (or are written). Defaults to <outputDir>/raw
 * @param {boolean} opts.skipGenerate  If true, don't call OpenAI; only reprocess existing raws
 * @param {object} opts.openaiClient   Required if !skipGenerate
 * @param {string} opts.model       e.g. 'gpt-image-1'
 * @param {string} opts.size        e.g. '1024x1024'
 * @param {number} opts.concurrency
 * @param {(msg: string) => void} opts.log
 * @param {string} opts.assetFilter Only process this single asset id
 */
export async function runPackPipeline(opts) {
  const {
    spec, outputDir,
    rawDir = path.join(outputDir, 'raw'),
    skipGenerate = false,
    openaiClient = null,
    model = 'gpt-image-1',
    size = '1024x1024',
    concurrency = 3,
    log = console.log,
    assetFilter = null,
    // Image-edit backend used when an asset has a reference image.
    // 'openai'  → gpt-image-1 /images/edits (requires org verification for edits)
    // 'gemini'  → Gemini 2.5 Flash Image (uses GEMINI_API_KEY)
    editProvider = 'openai',
    editModel = editProvider === 'gemini' ? 'gemini-2.5-flash-image' : null,
    geminiApiKey = process.env.GEMINI_API_KEY || null,
  } = opts;

  fs.mkdirSync(outputDir, { recursive: true });
  fs.mkdirSync(rawDir, { recursive: true });

  const defaultStyle = spec.defaultStyle || '';
  // Optional: per-spec reference directory. When set, each asset auto-resolves
  // its reference image as <referenceDir>/<asset.id>.png (unless the asset
  // sets `noReference: true` or supplies an explicit `reference` path).
  // Resolved relative to the spec's directory if a relative path is given.
  const referenceDir = spec.referenceDir ? path.resolve(spec.referenceDir) : null;
  let assets = spec.assets || [];
  if (assetFilter) assets = assets.filter(a => a.id === assetFilter);
  if (!assets.length) {
    log('No assets to process.');
    return { pack: {}, results: [] };
  }

  const results = [];
  const pack = {};

  let index = 0;
  async function worker(workerId) {
    while (index < assets.length) {
      const i = index++;
      const asset = assets[i];
      const tag = `[${i + 1}/${assets.length}] ${asset.id}`;

      const rawPath = path.join(rawDir, `${asset.id}.png`);
      try {
        // 1. Generate raw if missing (or always if !skipGenerate)
        if (!fs.existsSync(rawPath)) {
          if (skipGenerate) {
            log(`${tag} ✗ raw missing and --skip-generate set`);
            results.push({ id: asset.id, status: 'missing-raw' });
            continue;
          }
          const assetSize = asset.size || size;
          const assetStyle = asset.style || defaultStyle;

          // Resolve reference image: explicit per-asset path wins; otherwise
          // derive from spec.referenceDir / <id>.png. `noReference: true`
          // forces text-to-image even when a default ref would resolve.
          let refPath = null;
          if (!asset.noReference) {
            if (asset.reference) {
              refPath = path.resolve(asset.reference);
            } else if (referenceDir) {
              const candidate = path.join(referenceDir, `${asset.id}.png`);
              if (fs.existsSync(candidate)) refPath = candidate;
            }
          }

          let buf;
          if (refPath) {
            const prompt = buildEditPrompt(asset, assetStyle);
            if (editProvider === 'gemini') {
              if (!geminiApiKey) throw new Error('GEMINI_API_KEY required for editProvider=gemini');
              log(`${tag} editing from reference ${path.basename(refPath)} via gemini (${editModel})...`);
              buf = await generateOneEditGemini({
                apiKey: geminiApiKey, model: editModel, referencePath: refPath, prompt,
              });
            } else {
              log(`${tag} editing from reference ${path.basename(refPath)} via openai at ${assetSize}...`);
              buf = await generateOneEditOpenAI({
                openai: openaiClient, model, size: assetSize, referencePath: refPath, prompt,
              });
            }
          } else {
            log(`${tag} generating raw at ${assetSize}...`);
            const prompt = buildPrompt(asset, assetStyle);
            buf = await generateOne({
              openai: openaiClient, model, size: assetSize, prompt,
            });
          }
          fs.writeFileSync(rawPath, buf);
        } else if (!skipGenerate) {
          log(`${tag} raw exists, skipping generation`);
        }

        // 2. Crop + fit + assemble
        log(`${tag} processing...`);
        const { buf: sheetBuf, frameWidth, frameHeight, source, verification } =
          await processAssetToSheet(rawPath, asset);

        const outFile = `${asset.id}.png`;
        fs.writeFileSync(path.join(outputDir, outFile), sheetBuf);

        pack[asset.id] = {
          file: outFile,
          frames: asset.frames || 1,
          frameWidth,
          frameHeight,
          ...(source ? { detection: source } : {}),
          ...(verification ? { verification } : {}),
        };

        const verNote = verification
          ? (verification.pass ? ' ✓identity' : ` ⚠identity:${verification.failures.join(',')}`)
          : '';
        log(`${tag} ✓ ${frameWidth}×${frameHeight}×${asset.frames}${verNote}`);
        results.push({ id: asset.id, status: 'ok' });
      } catch (err) {
        log(`${tag} ✗ ${err.message}`);
        results.push({ id: asset.id, status: 'error', error: err.message });
      }
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, assets.length) }, (_, i) => worker(i));
  await Promise.all(workers);

  fs.writeFileSync(path.join(outputDir, 'pack.json'), JSON.stringify(pack, null, 2));
  log(`\nPack manifest written to ${path.join(outputDir, 'pack.json')}`);

  return { pack, results };
}
