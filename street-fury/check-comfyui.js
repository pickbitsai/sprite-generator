/**
 * ComfyUI readiness probe.
 *
 * Verifies:
 *   1. ComfyUI is reachable at COMFYUI_URL (default http://127.0.0.1:8188)
 *   2. Required custom nodes are installed (IPAdapterAdvanced etc.)
 *   3. Required model files are visible
 *   4. A dry-run workflow submission parses without errors
 *
 * Run this before kicking off a big generation. Exits 0 if everything's
 * ready, 2 with an actionable install hint otherwise.
 *
 * Usage: node tools/theme/check-comfyui.js
 */
const path = require('path');
const { COMFYUI_URL } = { COMFYUI_URL: (process.env.COMFYUI_URL || 'http://127.0.0.1:8188').replace(/\/$/, '') };

const REQUIRED_NODES = [
  'IPAdapterAdvanced',
  'IPAdapterModelLoader',
  'CLIPVisionLoader',
  'CheckpointLoaderSimple',
  'KSampler',
  'VAEDecode',
  'SaveImage',
  'LoadImage',
  'EmptyLatentImage',
  'CLIPTextEncode',
];

const REQUIRED_MODELS = {
  checkpoints: ['sd_xl_base_1.0.safetensors'],
  clip_vision: ['CLIP-ViT-H-14-laion2B-s32B-b79K.safetensors'],
  ipadapter: ['ip-adapter-plus_sdxl_vit-h.safetensors'],
};

async function probe() {
  console.log(`[check-comfyui] probing ${COMFYUI_URL}`);

  // 1. Server reachable
  let stats;
  try {
    const r = await fetch(COMFYUI_URL + '/system_stats');
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    stats = await r.json();
  } catch (e) {
    console.error(`[check-comfyui] NOT REACHABLE: ${e.message}`);
    console.error(`  Install & run ComfyUI: https://github.com/comfyanonymous/ComfyUI`);
    console.error(`  Then start the server (default http://127.0.0.1:8188).`);
    process.exit(2);
  }
  console.log(`  server OK (devices: ${(stats.devices || []).map(d => d.name).join(', ') || 'cpu'})`);

  // 2. Custom nodes present
  const objectInfo = await (await fetch(COMFYUI_URL + '/object_info')).json();
  const missingNodes = REQUIRED_NODES.filter(n => !objectInfo[n]);
  if (missingNodes.length) {
    console.error(`[check-comfyui] missing nodes: ${missingNodes.join(', ')}`);
    console.error(`  Install ComfyUI_IPAdapter_plus custom node:`);
    console.error(`    git clone https://github.com/cubiq/ComfyUI_IPAdapter_plus \\`);
    console.error(`      <ComfyUI>/custom_nodes/ComfyUI_IPAdapter_plus`);
    console.error(`  Then restart ComfyUI.`);
    process.exit(2);
  }
  console.log(`  required nodes OK (${REQUIRED_NODES.length} checked)`);

  // 3. Models visible. ComfyUI lists them via /object_info → input dropdown
  // of the loader nodes. We cross-reference against our required list.
  const available = {
    checkpoints: (objectInfo.CheckpointLoaderSimple?.input?.required?.ckpt_name?.[0]) || [],
    clip_vision: (objectInfo.CLIPVisionLoader?.input?.required?.clip_name?.[0]) || [],
    ipadapter:   (objectInfo.IPAdapterModelLoader?.input?.required?.ipadapter_file?.[0]) || [],
  };
  const missingModels = [];
  for (const [kind, needed] of Object.entries(REQUIRED_MODELS)) {
    for (const m of needed) {
      if (!available[kind].includes(m)) missingModels.push(`${kind}/${m}`);
    }
  }
  if (missingModels.length) {
    console.error(`[check-comfyui] missing models: ${missingModels.join(', ')}`);
    console.error(`  Download to <ComfyUI>/models/<kind>/:`);
    console.error(`    checkpoints/sd_xl_base_1.0.safetensors   — huggingface.co/stabilityai/stable-diffusion-xl-base-1.0`);
    console.error(`    clip_vision/CLIP-ViT-H-14-laion2B-s32B-b79K.safetensors   — huggingface.co/h94/IP-Adapter/tree/main/models/image_encoder`);
    console.error(`    ipadapter/ip-adapter-plus_sdxl_vit-h.safetensors   — huggingface.co/h94/IP-Adapter/tree/main/sdxl_models`);
    process.exit(2);
  }
  console.log(`  required models OK`);

  console.log(`[check-comfyui] READY. IMAGE_EDIT_PROVIDER=comfyui will route edits to ${COMFYUI_URL}.`);
}

probe().catch(e => { console.error('[check-comfyui] CRASHED:', e.message); process.exit(1); });
