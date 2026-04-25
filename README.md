# Sprite Generator

Generate game sprites with AI from a JSON manifest. Describe your assets, run the CLI, and get consistent illustrated PNGs — including sprite sheets with multiple angles and animation frames.

## What You Need

- **Node.js 18+**
- **An OpenAI API key** with access to `gpt-image-1` (set as `OPENAI_API_KEY` environment variable)

## Getting Started

### 1. Install

```bash
npm install pickbitsai/sprite-generator
```

### 2. Create a manifest

Pick a genre template or start from a basic starter:

```bash
npx sprite-generator init --list                    # show available templates
npx sprite-generator init --template shmup          # copy a genre template
npx sprite-generator init                           # basic 2-asset starter
```

Templates ship with a proof-of-concept screenshot showing the generated sprites rendered in a representative game scene, so you can evaluate the style before committing credits. See [Templates](#templates) below.

This creates a `manifest.json` in your project. Open it up — it has two key parts:

- **`defaultStyle`** — the art direction shared by all your sprites. This is the most important field. Example:
  ```
  "Pixel art sprite, transparent background, 64x64, retro game style, no text"
  ```

- **`assets`** — an array of things you want to generate. Each asset needs:
  - `id` — unique identifier, becomes the filename
  - `name` — display name
  - `emoji` — visual shorthand (used in previews)
  - `category` — groups assets into folders (e.g., "weapon", "character", "item")
  - `description` — what makes this asset unique. Gets combined with `defaultStyle` to form the full AI prompt

Here's a simple manifest:

```json
{
  "defaultStyle": "Pixel art sprite, transparent background, 64x64, retro game style, no text",
  "assets": [
    {
      "id": "health_potion",
      "name": "Health Potion",
      "emoji": "🧪",
      "category": "item",
      "description": "A glowing red potion in a round glass flask with a cork stopper"
    },
    {
      "id": "iron_sword",
      "name": "Iron Sword",
      "emoji": "🗡️",
      "category": "weapon",
      "description": "A simple iron longsword with a leather-wrapped grip"
    }
  ]
}
```

### 3. Preview your prompts

Before spending API credits, check what prompts will be sent:

```bash
OPENAI_API_KEY=sk-... npx sprite-generator --dry-run
```

This prints every prompt without calling the API. Make sure the style and descriptions look right.

### 4. Generate sprites

```bash
OPENAI_API_KEY=sk-... npx sprite-generator
```

Sprites are saved to `./output/<category>/<id>.png`:
```
output/
  item/health_potion.png
  weapon/iron_sword.png
```

### 5. Preview results

```bash
npx sprite-preview
```

Opens a browser grid at http://localhost:3333 showing all generated sprites grouped by category, with missing assets highlighted.

## Writing Good Prompts

- **`defaultStyle` controls consistency.** Be specific about: art style, background (usually "transparent background"), size, and what to avoid ("no text", "no shadows"). Every sprite gets this as a prefix, so it's what keeps your asset pack looking cohesive.

- **`description` should focus on what's unique.** Don't repeat things from `defaultStyle`. Instead of "A pixel art health potion on transparent background", just say "A glowing red potion in a round glass flask with a cork stopper".

- **`tags` add keywords.** Optional array appended to the prompt. Useful for reinforcing themes: `["rare", "glowing", "magical"]`.

- **Start small.** Generate one category first with `--dry-run` to check prompts, then generate it. Once you're happy with the style, do the rest.

- **Resume interrupted runs** with `--skip-existing` — it skips any asset that already has an output file.

- **Generate one category at a time** with `--category weapon` to focus on a subset.

- **Speed up large batches** with `--concurrency 5` (default is 3 parallel API calls).

## Sprite Sheets (Angles + Animations)

For characters or objects that need multiple viewpoints and animation frames, add `angles` and `animations` to your manifest.

### When to use sprite sheets

- A player character that needs front/back/side views
- Enemies with idle, walk, and attack animations
- Any asset that needs to look the same from different angles

### How it works

Add `angles` and/or `animations` either globally (top-level, applies to all assets) or per asset (overrides global). Assets without these fields still produce a single PNG.

```json
{
  "defaultStyle": "Pixel art sprite, transparent background, 64x64, retro game style, no text",
  "assets": [
    {
      "id": "hero",
      "name": "Hero",
      "emoji": "🦸",
      "category": "character",
      "description": "A knight in silver armor with a blue cape",
      "angles": ["front", "side", "back"],
      "animations": {
        "idle": { "frames": 2, "fps": 4 },
        "walk": { "frames": 4, "fps": 8 },
        "attack": {
          "frames": 3,
          "fps": 10,
          "frameDescriptions": ["raising sword overhead", "mid-swing at full extension", "follow-through, returning to stance"]
        }
      }
    },
    {
      "id": "health_potion",
      "name": "Health Potion",
      "emoji": "🧪",
      "category": "item",
      "description": "A glowing red potion in a round glass flask"
    }
  ]
}
```

Each angle/animation/frame combination is one API call. The hero above generates `3 angles × (2 + 4 + 3) frames = 27 API calls`. Use `--dry-run` to check the total before generating.

### Output structure

```
output/character/hero/
  frames/
    front-idle-0.png
    front-idle-1.png
    front-walk-0.png
    front-walk-1.png
    front-walk-2.png
    front-walk-3.png
    front-attack-0.png
    ...
  hero-sheet.png       # all frames combined into one image
  hero-sheet.json      # metadata for game engines
```

The sprite sheet is laid out as a grid: **rows = angles**, **columns = animation frames** (left to right). The metadata JSON includes everything a game engine needs:

```json
{
  "id": "hero",
  "image": "hero-sheet.png",
  "frameWidth": 1024,
  "frameHeight": 1024,
  "columns": 9,
  "rows": 3,
  "angles": ["front", "side", "back"],
  "animations": {
    "idle": { "frames": 2, "fps": 4 },
    "walk": { "frames": 4, "fps": 8 },
    "attack": { "frames": 3, "fps": 10 }
  },
  "frameMap": [
    { "index": 0, "angle": "front", "animation": "idle", "frame": 0, "x": 0, "y": 0 },
    { "index": 1, "angle": "front", "animation": "idle", "frame": 1, "x": 1024, "y": 0 },
    ...
  ]
}
```

This works with Phaser, Godot, Unity, and any engine that supports sprite sheet grids.

### Built-in animation descriptions

The generator includes natural-language frame descriptions for common animations: **idle**, **walk**, **run**, **attack**, **jump**, **death**. These tell the AI what pose to draw for each frame (e.g., "starting step, left foot forward" for walk frame 1).

For custom animations, provide your own `frameDescriptions` array — one string per frame describing the pose.

### Frames only (no assembly)

Use `--no-sheet` to generate individual frame PNGs without combining them into a sprite sheet:

```bash
OPENAI_API_KEY=sk-... npx sprite-generator --no-sheet
```

## All CLI Options

### sprite-generator [init] [options]

| Option | Default | Description |
|--------|---------|-------------|
| `init` | | Create a starter manifest.json in the current directory |
| `--manifest <path>` | `./manifest.json` | Path to asset manifest JSON |
| `--output <dir>` | `./output` | Output directory for sprites |
| `--style <prompt>` | manifest's `defaultStyle` | Override the default style prompt |
| `--size <WxH>` | `1024x1024` | `1024x1024`, `1024x1536`, `1536x1024`, or `auto` |
| `--model <name>` | `gpt-image-1` | `gpt-image-1` or `dall-e-3` |
| `--category <name>` | | Only generate one category |
| `--skip-existing` | `false` | Skip assets that already have output files |
| `--concurrency <n>` | `3` | Parallel API requests |
| `--dry-run` | `false` | Preview prompts without calling the API |
| `--no-sheet` | `false` | Generate individual frames but skip sprite sheet assembly |

### sprite-preview [options]

| Option | Default | Description |
|--------|---------|-------------|
| `--manifest <path>` | `./manifest.json` | Path to manifest JSON |
| `--output <dir>` | `./output` | Directory with generated sprites |
| `--port <n>` | `3333` | Server port |

## Reusable Libraries (`lib/`)

Standalone ES modules for common sprite pipeline tasks. Import them into your own scripts:

### idle-variants.js — Programmatic Idle Animation

Generate 1 AI frame, get N animation frames for free via pixel shifting. The same technique 16-bit beat-em-ups used — zero identity drift between frames.

```js
import { generateIdleVariants } from './lib/idle-variants.js';

// Creates idle_1.png (original), idle_2.png (-2px), idle_3.png (0px), idle_4.png (+1px)
await generateIdleVariants('idle_1.png', 'output/', 4);
```

### verify-identity.js — Frame Identity Checking

Catches "4 different people" across animation frames using Normalised Cross-Correlation (NCC). Scores 0-1 where 1 = identical, <0.70 = identity drift.

```js
import { verifyFrameIdentity } from './lib/verify-identity.js';

const result = await verifyFrameIdentity(['idle_1.png', 'idle_2.png', 'idle_3.png']);
if (!result.pass) console.log('Identity drift:', result.failures);
// { pass: false, minNCC: 0.42, failures: ['Identity NCC 0.42 (need ≥0.70)'] }
```

### assemble-sheet.js — Sprite Sheet Assembly

Pack individual frames into a grid-based sprite sheet with configurable cell size and margins.

```js
import { assembleSheet, resizeToCell } from './lib/assemble-sheet.js';

const cells = [
  { buf: await resizeToCell('idle_1.png', 256, 26), row: 0, col: 0 },
  { buf: await resizeToCell('idle_2.png', 256, 26), row: 0, col: 1 },
  { buf: await resizeToCell('attack_1.png', 256, 26), row: 1, col: 0 },
];
const sheet = await assembleSheet(cells, 2, 4, 256);
fs.writeFileSync('character.png', sheet);
```

### clean-bg.js — Background Removal

AI generators ignore "transparent background" prompts. This flood-fills from corners to remove the baked-in background while preserving interior regions.

```js
import { cleanBackground } from './lib/clean-bg.js';
await cleanBackground('ai_output.png', 'clean.png', { threshold: 60 });
```

## Theme Pipeline (`street-fury/`)

A 35-stage pipeline for reskinning a base beat-em-up into a new visual theme. You supply (1) a short description of the theme in your own words and (2) your existing character reference sheets; the pipeline re-renders characters, enemies, bosses, and backgrounds in that theme while keeping the gameplay geometry identical. Generated art is driven entirely by your prompt + your reference art — no franchise art is ingested.

The pipeline was built against a specific base game layout, so `GAME_ROOT` must point at a project structured the same way (characters + enemies + bosses + backgrounds in known directories). Most sprite-generator users will not need this — stick with `npx sprite-generator` for text-only asset packs.

### Quick Start

```bash
# Point GAME_ROOT at a base game with the expected directory layout
export GAME_ROOT=/path/to/base-game

# Generate a new theme — describe it in your own words, any theme name you like
npm run theme -- neon_samurai "A cyberpunk Edo city with chrome katanas and neon rain"

# Resume a failed run
npm run theme -- neon_samurai --from verify-gameplay

# Validate an existing theme
npm run theme:validate -- neon_samurai
```

### Pipeline Stages

```
concept → backgrounds → verify-backgrounds → references → characters →
enemies → bosses → clean-frames → validate-frames → verify-consistency →
verify-walk-cycle → assemble → verify-sheet-layout → build-config →
verify-gameplay → verify-enemy-render → verify-boss-render →
verify-pickups-render → verify-character-select → capture-character-select →
capture-walks → capture-enemies → capture-bosses → capture-pickups →
capture-backgrounds → capture-review-sheet → validate
```

### Key Features

- **Self-healing verification gates** — when a stage fails, the orchestrator reruns upstream fix-it stages automatically before giving up
- **Programmatic idle frames** — 1 AI frame + 3 pixel-shifted variants (zero drift)
- **Identity-locked image editing** — Gemini or ComfyUI+IP-Adapter for consistent pose changes
- **NCC identity verification** — catches visual drift on the character select screen
- **Review sheet output** — single PNG showing character select + gameplay for visual sign-off
- **Unified sprite sizing** — role-based target heights with automatic margin compensation for themed cells

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `GAME_ROOT` | Yes | Path to the base game project |
| `GEMINI_API_KEY` | Yes | Google AI API key for image generation |
| `IMAGE_EDIT_PROVIDER` | No | `gemini` (default) or `comfyui` |
| `COMFYUI_URL` | No | ComfyUI server URL for local generation |

## Templates

Genre starter packs. Each one ships with a manifest, a standalone `demo.html` that renders the generated sprites in a representative scene, a `capture.js` Playwright script, and a committed `screenshot.png` proving the pack produces coherent output before you spend a cent.

| Template | Assets | What it covers |
|---|---|---|
| [`shmup`](templates/shmup/README.md) | 13 | Top-down vertical shoot-em-up — player, 3 enemy variants, boss, projectiles, pickups, tileable starfield |
| [`platformer`](templates/platformer/README.md) | 10 | Side-scrolling platformer — hero, slime/bat, pickups, tileable ground, checkpoint, parallax hills |
| [`racing`](templates/racing/README.md) | 11 | Top-down arcade racer — player car, 3 opponents, road + curve tiles, obstacles, boost/shield, finish line |
| [`zombie-survival`](templates/zombie-survival/README.md) | 11 | Top-down twin-stick survival — survivor, 3 zombie variants, pistol/shotgun, blood splatter, tileable grass + road |
| [`tower-defense`](templates/tower-defense/README.md) | 11 | 60° elevation — 3 tower types, 3 creep variants, projectiles, gold, tileable path + grass |
| [`pixel-puzzle`](templates/pixel-puzzle/README.md) | 10 | Match-3 — 5 gem colors, bomb + rainbow specials, sparkle/burst effects, tileable board cell |

```bash
npx sprite-generator init --template <name>            # copy the manifest
OPENAI_API_KEY=sk-... npx sprite-generator              # generate the sprites
node node_modules/sprite-generator/templates/<name>/capture.js  # rebuild screenshot
```

Want to make your own template? Copy an existing `templates/<name>/` directory, tweak the manifest, adjust the demo layout, and submit a PR.

## License

MIT
