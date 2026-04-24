# Netrunner Legacy — Example Bundle

A complete, real-world example of the sprite-generator pipeline for a top-down cyberpunk dungeon crawler. Four playable classes with full directional animation sets, character-select portraits, and world props.

## What's in here

| File | What it is |
|------|-----------|
| `build-anim-manifest.js` | Script that emits per-class animation manifests programmatically. Demonstrates how to generate large manifests from character definitions instead of hand-writing JSON. |
| `generate-sheets.js` | Alternative **Gemini**-based sheet generator. Groups manifest entries by (category, action) and asks the model for one grid per group, then slices into frames. Much faster than per-frame calls but requires `GEMINI_API_KEY`. |
| `netrunner-anim-manifest.json` | Per-frame manifest for the Netrunner class (8 directions × multiple actions). |
| `street_samurai-anim-manifest.json` | Same, for the Street Samurai class. |
| `infiltrator-anim-manifest.json` | Same, for the Infiltrator class. |
| `rigger-anim-manifest.json` | Same, for the Rigger class. |
| `all-classes-anim-manifest.json` | Combined manifest — all four classes in one file, for batch runs. |
| `netrunner-manifest.json` | Basic (non-animated) manifest: world assets, enemies, items. |
| `class-avatars-manifest.json` | Character-select portraits (512×512, facing forward). |
| `hospital-manifest.json` | Top-down building sprites (GTA2-style). |

## Running the examples

Regenerate the animation manifests:

```bash
node build-anim-manifest.js
```

Generate a class with the default OpenAI pipeline:

```bash
OPENAI_API_KEY=sk-... npx sprite-generator --manifest netrunner-anim-manifest.json
```

Generate with Gemini sheets (one API call per action group, not per frame):

```bash
GEMINI_API_KEY=... node generate-sheets.js --manifest netrunner-anim-manifest.json
```
