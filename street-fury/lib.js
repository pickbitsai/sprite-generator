// Shared helpers for the theme generation pipeline.
const fs = require('fs');
const path = require('path');

// Game root: when running from the Turtles project, __dirname is tools/theme/
// and ROOT is two levels up. When running from sprite-generator, set GAME_ROOT
// env var to point at the game project (e.g. C:\new\Turtles).
const ROOT = process.env.GAME_ROOT || path.join(__dirname, '..', '..');

function loadEnv() {
  const envPath = path.join(ROOT, '.env');
  if (!fs.existsSync(envPath)) {
    throw new Error(`Missing ${envPath} — copy .env.example and set keys`);
  }
  const envFile = fs.readFileSync(envPath, 'utf-8');
  const out = {};
  for (const line of envFile.split(/\r?\n/)) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/);
    if (m) out[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  }
  return out;
}

// Legacy helper — returns the Gemini key (still used by concept stage).
function loadApiKey() {
  const env = loadEnv();
  if (!env.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY not set in .env');
  return env.GEMINI_API_KEY;
}

// Which image provider to use. Set via env var IMAGE_PROVIDER=openai|imagen
// Default: imagen (if GEMINI_API_KEY set), else openai.
function pickProvider() {
  const env = loadEnv();
  const forced = (process.env.IMAGE_PROVIDER || '').toLowerCase();
  if (forced === 'openai' || forced === 'imagen') return forced;
  if (env.GEMINI_API_KEY && !env.OPENAI_API_KEY) return 'imagen';
  if (env.OPENAI_API_KEY && !env.GEMINI_API_KEY) return 'openai';
  return env.GEMINI_API_KEY ? 'imagen' : 'openai';
}

function loadImageKey(provider) {
  const env = loadEnv();
  if (provider === 'openai') {
    if (!env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY not set in .env');
    return env.OPENAI_API_KEY;
  }
  if (!env.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY not set in .env');
  return env.GEMINI_API_KEY;
}

function themeDir(themeId) {
  return path.join(ROOT, 'src', 'themes', themeId);
}

function themeAssetDir(themeId, sub) {
  const dir = path.join(themeDir(themeId), sub);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function loadThemeConfig(themeId) {
  const configPath = path.join(themeDir(themeId), 'config.json');
  if (!fs.existsSync(configPath)) {
    throw new Error(`Missing ${configPath} — run concept stage first`);
  }
  return JSON.parse(fs.readFileSync(configPath, 'utf-8'));
}

function saveThemeConfig(themeId, config) {
  fs.mkdirSync(themeDir(themeId), { recursive: true });
  const p = path.join(themeDir(themeId), 'config.json');
  fs.writeFileSync(p, JSON.stringify(config, null, 2));
  return p;
}

const SPRITE_STYLE = '16-bit retro arcade beat-em-up sprite art, style of Streets of Rage or Final Fight. Clean pixel-art inspired rendering with bold black outlines, vibrant saturated colors, side-view profile facing right. Plain solid white background. NO shadow on ground, NO ground line, NO text, NO other objects. Full body visible head to feet. Character centered, filling about 80% of vertical space.';

const BG_STYLE = '16-bit retro arcade beat-em-up background art, style of Streets of Rage or Final Fight. Horizontal scrolling side-scroller background. Clean pixel-art inspired rendering. No characters, no people, no UI, no text. Wide horizontal composition.';

async function _callImagen(apiKey, prompt, opts) {
  const aspect = (opts && opts.aspectRatio) || '1:1';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/imagen-4.0-generate-001:predict?key=${apiKey}`;
  const body = {
    instances: [{ prompt }],
    parameters: {
      sampleCount: 1,
      aspectRatio: aspect,
      personGeneration: 'allow_all',
    },
  };
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error(`Imagen ${resp.status}: ${txt.slice(0, 300)}`);
  }
  const data = await resp.json();
  const pred = (data.predictions || [])[0];
  if (!pred || !pred.bytesBase64Encoded) throw new Error('No image returned');
  return Buffer.from(pred.bytesBase64Encoded, 'base64');
}

async function _callOpenAI(apiKey, prompt, opts) {
  const aspect = (opts && opts.aspectRatio) || '1:1';
  // gpt-image-1 supports 1024x1024, 1024x1536 (portrait), 1536x1024 (landscape)
  const size = aspect === '16:9' ? '1536x1024'
             : aspect === '9:16' ? '1024x1536'
             : '1024x1024';
  const resp = await fetch('https://api.openai.com/v1/images/generations', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: 'gpt-image-1',
      prompt,
      size,
      n: 1,
      // gpt-image-1 returns base64 by default; no response_format arg needed
    }),
  });
  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error(`OpenAI ${resp.status}: ${txt.slice(0, 300)}`);
  }
  const data = await resp.json();
  const b64 = data?.data?.[0]?.b64_json;
  if (!b64) throw new Error('No image returned from OpenAI');
  return Buffer.from(b64, 'base64');
}

// Unified image-call entry point. Apps pass whatever key they already have but
// it is ignored — we reload the right key per-provider here so the caller
// doesn't need to know which provider is active.
async function callImagen(_apiKeyIgnored, prompt, opts) {
  const provider = pickProvider();
  const key = loadImageKey(provider);
  if (provider === 'openai') return _callOpenAI(key, prompt, opts);
  return _callImagen(key, prompt, opts);
}

// Image-edit entry point. Uses Gemini 2.5 Flash Image ("Nano Banana"), which
// accepts an image + text prompt and returns an edited image. This is how we
// lock character identity across every pose: generate one reference per
// entity, then each subsequent pose is an EDIT of that reference instead of
// a fresh text-to-image roll.
async function callGeminiImageEdit(apiKey, referenceBuf, prompt, opts) {
  const model = (opts && opts.model) || 'gemini-2.5-flash-image';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const body = {
    contents: [{
      parts: [
        { inline_data: { mime_type: 'image/png', data: referenceBuf.toString('base64') } },
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
    throw new Error(`GeminiEdit ${resp.status}: ${txt.slice(0, 300)}`);
  }
  const data = await resp.json();
  const parts = data.candidates?.[0]?.content?.parts || [];
  const imgPart = parts.find(p => p.inline_data || p.inlineData);
  const b64 = imgPart && (imgPart.inline_data?.data || imgPart.inlineData?.data);
  if (!b64) throw new Error('GeminiEdit: no image in response');
  return Buffer.from(b64, 'base64');
}

// ComfyUI client. Runs fully local against http://127.0.0.1:8188 with
// IP-Adapter for identity lock + text-prompt-driven pose. Zero API tokens.
// Provider is picked via IMAGE_EDIT_PROVIDER=comfyui|gemini (default: gemini
// if no COMFYUI_URL is set and GEMINI_API_KEY is, otherwise comfyui).
const COMFYUI_URL = () => (process.env.COMFYUI_URL || 'http://127.0.0.1:8188').replace(/\/$/, '');
const COMFYUI_WORKFLOW_PATH = path.join(__dirname, 'comfyui', 'workflow-ipadapter.json');

async function comfyFetch(method, pathPart, body, isMultipart) {
  const url = COMFYUI_URL() + pathPart;
  const init = { method };
  if (body !== undefined) {
    if (isMultipart) {
      init.body = body; // FormData
    } else {
      init.headers = { 'Content-Type': 'application/json' };
      init.body = JSON.stringify(body);
    }
  }
  const resp = await fetch(url, init);
  if (!resp.ok) {
    const txt = await resp.text().catch(() => '');
    throw new Error(`ComfyUI ${resp.status} on ${method} ${pathPart}: ${txt.slice(0, 200)}`);
  }
  const ct = resp.headers.get('content-type') || '';
  if (ct.includes('application/json')) return resp.json();
  return Buffer.from(await resp.arrayBuffer());
}

async function uploadImageToComfyUI(buf, filename) {
  const form = new FormData();
  const blob = new Blob([buf], { type: 'image/png' });
  form.append('image', blob, filename);
  form.append('overwrite', 'true');
  const resp = await fetch(COMFYUI_URL() + '/upload/image', { method: 'POST', body: form });
  if (!resp.ok) throw new Error(`ComfyUI upload ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
  const json = await resp.json();
  return json.name; // server-side filename to reference in the workflow
}

// Substitute placeholders in the workflow template. We re-read the template
// every call so the user can tweak it on disk without restarting the
// generator. Placeholders: __<KEY>__ for each uploaded image key,
// __POSITIVE_PROMPT__, __SEED__.
function buildWorkflow(uploadedImages, positivePrompt, seed, workflowPath) {
  const p = workflowPath || COMFYUI_WORKFLOW_PATH;
  if (!fs.existsSync(p)) throw new Error(`ComfyUI workflow template missing: ${p}`);
  let text = fs.readFileSync(p, 'utf-8');
  for (const [key, filename] of Object.entries(uploadedImages)) {
    text = text.replaceAll(`__${key}__`, filename);
  }
  text = text
    .replaceAll('__POSITIVE_PROMPT__', positivePrompt.replace(/"/g, '\\"'))
    .replaceAll('__SEED__', String(seed));
  return JSON.parse(text);
}

// First arg accepts either a single Buffer (legacy — uploaded as REF_IMAGE)
// or an object { KEY: buf, ... } for workflows that need multiple inputs
// (e.g. img2img + IP-Adapter reference + ControlNet pose image).
// opts.workflowPath picks an alternate template; defaults to the IP-Adapter
// identity-edit workflow.
async function callComfyUI(imagesOrRefBuf, prompt, opts) {
  opts = opts || {};
  const seed = opts.seed || Math.floor(Math.random() * 1e15);
  const imagesMap = Buffer.isBuffer(imagesOrRefBuf)
    ? { REF_IMAGE: imagesOrRefBuf }
    : imagesOrRefBuf;

  const uploaded = {};
  for (const [key, buf] of Object.entries(imagesMap)) {
    const name = `${key.toLowerCase()}-${Date.now()}-${Math.floor(Math.random() * 1e6)}.png`;
    uploaded[key] = await uploadImageToComfyUI(buf, name);
  }

  const workflow = buildWorkflow(uploaded, prompt, seed, opts.workflowPath);
  const clientId = 'street-fury-' + Math.random().toString(36).slice(2, 10);
  const queued = await comfyFetch('POST', '/prompt', { prompt: workflow, client_id: clientId });
  const promptId = queued.prompt_id;
  if (!promptId) throw new Error('ComfyUI did not return a prompt_id');

  // Poll history until the prompt finishes. ComfyUI writes outputs as soon
  // as the SaveImage node runs.
  const started = Date.now();
  const timeoutMs = opts.timeoutMs || 180000;
  while (Date.now() - started < timeoutMs) {
    const hist = await comfyFetch('GET', `/history/${promptId}`);
    const entry = hist && hist[promptId];
    if (entry) {
      // Surface execution errors immediately instead of timing out silently.
      // status.status_str is 'success' | 'error'; messages carries node-level
      // exceptions when a node (e.g. ControlNetLoader) blows up.
      if (entry.status && entry.status.status_str === 'error') {
        const errMsg = (entry.status.messages || [])
          .filter(m => m[0] === 'execution_error')
          .map(m => `${m[1].node_type}(${m[1].node_id}): ${(m[1].exception_message || '').trim()}`)
          .join(' | ') || 'unknown error';
        throw new Error(`ComfyUI execution error — ${errMsg}`);
      }
      if (entry.outputs) {
        for (const nodeOut of Object.values(entry.outputs)) {
          if (!nodeOut.images) continue;
          const img = nodeOut.images[0];
          const qs = new URLSearchParams({ filename: img.filename, subfolder: img.subfolder || '', type: img.type || 'output' });
          const buf = await comfyFetch('GET', `/view?${qs.toString()}`);
          return buf;
        }
      }
    }
    await sleep(800);
  }
  throw new Error(`ComfyUI timed out after ${timeoutMs}ms waiting on prompt ${promptId}`);
}

function pickEditProvider() {
  const forced = (process.env.IMAGE_EDIT_PROVIDER || '').toLowerCase();
  if (forced === 'comfyui' || forced === 'gemini') return forced;
  // Default: if ComfyUI is explicitly configured via URL, use it; otherwise
  // fall back to Gemini if we have a key.
  if (process.env.COMFYUI_URL) return 'comfyui';
  const env = loadEnv();
  if (env.GEMINI_API_KEY) return 'gemini';
  return 'comfyui'; // assume local default
}

// Unified editor. Loads the reference from disk each call (cheap) so the
// caller only needs to pass a path. Dispatches on IMAGE_EDIT_PROVIDER:
//  - comfyui : local ComfyUI + IPAdapter (no API tokens)
//  - gemini  : Gemini 2.5 Flash Image (API tokens)
async function editWithRetry(apiKey, referencePath, prompt, outPath, opts) {
  if (fs.existsSync(outPath) && !opts?.force) return { skipped: true };
  if (!fs.existsSync(referencePath)) return { err: `missing reference ${referencePath}` };
  const ref = fs.readFileSync(referencePath);
  const provider = pickEditProvider();
  const maxAttempts = 3;
  for (let i = 0; i < maxAttempts; i++) {
    try {
      let buf;
      if (provider === 'comfyui') {
        buf = await callComfyUI(ref, prompt, opts);
      } else {
        const env = loadEnv();
        const key = env.GEMINI_API_KEY || apiKey;
        if (!key) throw new Error('GEMINI_API_KEY required for gemini image edit');
        buf = await callGeminiImageEdit(key, ref, prompt, opts);
      }
      fs.writeFileSync(outPath, buf);
      await sleep(provider === 'comfyui' ? 200 : 1200);
      return { ok: true, provider };
    } catch (err) {
      if (i === maxAttempts - 1) return { err: `${provider}: ${err.message}` };
      await sleep(provider === 'comfyui' ? 1500 : 3000 * (i + 1));
    }
  }
}

async function callGeminiText(apiKey, prompt, opts) {
  const model = (opts && opts.model) || 'gemini-2.5-flash';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: (opts && opts.temperature) || 0.8,
      responseMimeType: (opts && opts.json) ? 'application/json' : 'text/plain',
    },
  };
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error(`Gemini ${resp.status}: ${txt.slice(0, 300)}`);
  }
  const data = await resp.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('No text returned from Gemini');
  return text;
}

// Generate with variants, skip existing files, retry on quota errors.
async function generateWithRetry(apiKey, prompt, outPath, opts) {
  if (fs.existsSync(outPath) && !opts?.force) {
    return { skipped: true };
  }
  const maxAttempts = 3;
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const buf = await callImagen(apiKey, prompt, opts);
      fs.writeFileSync(outPath, buf);
      await sleep(1200);
      return { ok: true };
    } catch (err) {
      if (i === maxAttempts - 1) return { err: err.message };
      await sleep(3000 * (i + 1));
    }
  }
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function parseThemeIdFromArgs(argv, fallback) {
  const id = argv[2] || fallback;
  if (!id) {
    console.error('Usage: node tools/theme/<script>.js <theme-id>');
    process.exit(1);
  }
  return id.toLowerCase().replace(/[^a-z0-9_-]/g, '-');
}

module.exports = {
  ROOT,
  loadApiKey,
  themeDir,
  themeAssetDir,
  loadThemeConfig,
  saveThemeConfig,
  callImagen,
  callGeminiText,
  callGeminiImageEdit,
  callComfyUI,
  pickEditProvider,
  editWithRetry,
  generateWithRetry,
  sleep,
  parseThemeIdFromArgs,
  SPRITE_STYLE,
  BG_STYLE,
};
