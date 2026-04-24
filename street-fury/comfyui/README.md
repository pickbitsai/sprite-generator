# ComfyUI workflow

`workflow-ipadapter.json` is a ComfyUI API-format graph: **SDXL + IP-Adapter Plus** for identity-locked pose editing.

Placeholders are substituted at submit time by `lib.js:buildWorkflow`:

- `__REF_IMAGE__` — server-side filename returned by `/upload/image`
- `__POSITIVE_PROMPT__` — the pose description (quotes pre-escaped by lib.js)
- `__SEED__` — random integer per call

`lib.js` does raw string replacement, so the graph can be restructured freely as long as those tokens remain and the result is still valid ComfyUI API-format JSON.

**Do not add a `_comment` key** or any non-numeric top-level key to the JSON — ComfyUI treats every top-level key as a node ID and will crash with `AttributeError: 'str' object has no attribute 'get'` when it tries to read `class_type` off a string value.

## Requirements

- Custom node: [`ComfyUI_IPAdapter_plus`](https://github.com/cubiq/ComfyUI_IPAdapter_plus)
- Models:
  - `checkpoints/sd_xl_base_1.0.safetensors`
  - `clip_vision/CLIP-ViT-H-14-laion2B-s32B-b79K.safetensors`
  - `ipadapter/ip-adapter-plus_sdxl_vit-h.safetensors`

Verify with `node tools/theme/check-comfyui.js`.
