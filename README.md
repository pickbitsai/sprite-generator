# Sprite Generator

Generate game sprites with AI. Three tools, pick the one that matches what you're actually making:

| You need... | Use | Why |
|---|---|---|
| Independent static assets — icons, items, tiles, pickups | [`generate`](#getting-started) | One call per asset. Simplest path; identity consistency doesn't matter because nothing needs to match anything else. |
| A character with several **consistent poses**, no motion | [`pack`](#pack--identity-locked-pose-sheets) | One edit call re-renders a reference character across N poses in a single image — identity is locked structurally, not hoped for across independent calls. |
| A character with real **animation** — an attack windup, a death, a walk cycle | [`animate`](#animate--motion-not-just-poses) | A video model actually animates one seed frame; you harvest the in-between frames out of the result. The only method that produces real motion instead of a flashcard. |

`generate` alone drifts the moment you ask it for multiple angles or animation frames of the *same*
character — each call is independent, so nothing keeps frame 3 looking like frame 1. `pack` and `animate`
exist specifically to fix that, in two different ways: `pack` locks identity by editing one reference
image; `animate` locks it by construction, because every frame comes from the same continuous video.

## What You Need

- **Node.js 20+**
- **An OpenAI API key** with access to `gpt-image-1` (set as `OPENAI_API_KEY`) — used by `generate`, `pack`, and `animate`'s seed step
- **A Replicate API token** (set as `REPLICATE_API_TOKEN`) — only if you use `animate`
- **`ffmpeg` on PATH** — only if you use `animate`

## Getting Started

### 1. Install

```bash
npm install --save-dev github:pickbitsai/sprite-generator
```

The npm registry release will use `@pickbitsai/sprite-generator`. Until that
release is published, the GitHub install above is the supported install path.

### 2. Create a manifest

Pick a genre template or start from a basic starter:

```bash
npx sprite-generator init --list                    # show available templates
npx sprite-generator init --template shmup          # copy a genre template
npx sprite-generator init                           # basic 2-asset starter
```

Each template has a proof-of-concept screenshot in the repository showing the generated sprites rendered in a representative game scene, so you can evaluate the style before committing credits. See [Templates](#templates) below.

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

## Pack — Identity-Locked Pose Sheets

`generate`'s per-frame calls are independent — ask for "idle" and "attack" separately and you may get
two different-looking characters. `pack` fixes this for characters that need several **consistent
poses but no motion**: give it one reference image of your character, and it makes a single
identity-locked edit call that re-renders that same character across every pose you asked for, laid out
left-to-right in one sheet. Because it's one call editing one reference, there's nothing for the poses to
drift *from*.

It also does the boring-but-essential part `generate` doesn't: detects each frame's bounding box
(handling AI sheets where frames touch, overlap, or aren't evenly spaced), rescales every frame by a
single uniform factor so a run pose doesn't come out twice the size of an idle pose, and optionally runs
an NCC identity check across the result.

### Quick start

Write a `game-pack.json` spec:

```json
{
  "defaultStyle": "16-bit pixel art, vibrant saturated palette, crisp clean edges",
  "referenceDir": "./references",
  "assets": [
    {
      "id": "hero",
      "description": "idle, walk, attack, hurt, death — side view, facing right",
      "frames": 5,
      "targetFrameWidth": 128,
      "targetFrameHeight": 128,
      "layout": "character",
      "verifyIdentity": true
    }
  ]
}
```

Drop a reference image at `references/hero.png` (any size), then:

```bash
OPENAI_API_KEY=sk-... npx sprite-generator pack --spec game-pack.json --output public/sprites
```

This writes `public/sprites/hero.png` (a 5-frame sheet, each cell exactly 128×128) and
`public/sprites/pack.json` (frame count/dimensions/verification result per asset).

### Spec fields (per asset)

| Field | Required | Description |
|---|---|---|
| `id` | yes | Filename stem; also used to auto-resolve `<referenceDir>/<id>.png` |
| `frames` | yes (for characters) | Poses laid out left-to-right |
| `targetFrameWidth` / `targetFrameHeight` | yes (for characters) | Exact output cell size — the pipeline crops and rescales to hit this precisely |
| `anchor` | no | `bottom` (default for `character`) \| `center` (default for tiles/pickups/projectiles) \| `top` |
| `layout` | no | `character` \| `tiles` \| `pickups` \| `projectiles` \| `background` |
| `verifyIdentity` | no | Run the NCC drift check (see [verify-identity.js](#verify-identityjs--frame-identity-checking)) across the output frames |
| `reference` | no | Explicit reference image path (overrides `<referenceDir>/<id>.png`) |
| `noReference` | no | Force plain text-to-image even if a reference would resolve |
| `transparent` | no | Set `false` for backgrounds — flattens onto an opaque color instead of keeping alpha |
| `padding` | no | Px margin inside each cell (default: 4 for characters, 0 for backgrounds) |

### sprite-generator pack [options]

| Option | Default | Description |
|---|---|---|
| `--spec <path>` | `./game-pack.json` | Pack spec JSON |
| `--output <dir>` | `./output` | Where sheets + `pack.json` are written |
| `--raw <dir>` | `<output>/raw` | Where ungenerated/regenerated raw AI output is cached |
| `--skip-generate` | `false` | Skip the API entirely and reprocess whatever's already in `--raw` — use this to re-tune `targetFrameWidth`/`anchor`/`padding` without spending credits again |
| `--asset <id>` | | Only process one asset from the spec |
| `--edit-provider <name>` | `openai` | `openai` (gpt-image-1 `/images/edits`) or `gemini` (Gemini 2.5 Flash Image) — use `gemini` if your OpenAI org has edits gated but generations open |
| `--edit-model <name>` | | Override the edit model for the chosen provider |
| `--model` / `--size` / `--concurrency` | same as `generate` | |

## Animate — Motion, Not Just Poses

Neither `generate` nor `pack` can produce real **in-between motion** — a punch's anticipation and
follow-through, the specific way a character crumples on death — because nothing ever asked a model to
animate anything; both just generate a series of stills and hope they read as connected.

`animate` asks a video model to actually animate one seed image, then lets you harvest whichever frames
out of the result read as the poses you want. Identity drift is solved **by construction**: every frame
comes from the same continuous video of the same character, so there's nothing for it to drift between.
The tradeoff is cost and time — an image-to-video generation is dollars, not cents, and takes minutes —
but you get real anticipation/smear/recovery frames a per-pose generator can't invent, and the one step
that can't be automated (picking which frames to keep) costs nothing to redo if you pick badly.

### Quick start — four stages, one human judgment call

```bash
# 1. One seed still on a flat magenta background (video models animate solid
#    backgrounds far more reliably than transparent ones).
OPENAI_API_KEY=sk-... npx sprite-generator animate seed \
  --prompt "a lean cyber-ninja hero, matte black armor with glowing teal accents, 3/4 side view facing right, ready combat stance" \
  --out seed.png

# 2. Animate it. Describe the MOTION here, not the character — the seed
#    image already carries identity; re-describing it invites drift.
REPLICATE_API_TOKEN=r8_... npx sprite-generator animate motion \
  --image seed.png --prompt "winds up and throws a heavy overhand punch" \
  --out clip.mp4

# 3. Explode the clip into numbered frames + a contact sheet.
npx sprite-generator animate extract --video clip.mp4 --out frames/ --contact

# --- LOOK AT frames/_contact.png. Pick the frame numbers that read as ---
# --- anticipation / impact / follow-through at a glance. -----------------

# 4. Chroma-key the background out and assemble your picks into a sheet.
npx sprite-generator animate sheet \
  --framesDir frames/ --pick 16,26,33,47 --out punch-sheet.png
```

### What makes this work (learned the hard way — don't skip these)

- **Magenta, not transparency, for the seed you're about to animate.** Video models animate a solid
  background far more reliably than an alpha one; `--bg transparent` is only for a standalone still,
  not a frame headed into `animate motion`.
- **The chroma-key despills the fringe automatically.** A raw magenta key leaves a purple/pink halo
  around the character (compression softens the edge into a blend of the two colors); `animate sheet`
  pulls the fringe back toward neutral rather than leaving it.
- **Frames are bottom-anchored into a uniform cell**, not centered — characters share a ground line
  instead of bobbing up and down between poses.
- **Prompt the motion, not the character, in step 2.** The pixels already carry identity. Naming or
  describing the character again is wasted at best; on a recognizable design it can also trip
  IP-moderation on some providers.

### sprite-generator animate <stage> [options]

| Stage | Key options | Description |
|---|---|---|
| `seed` | `--prompt` (required), `--out`, `--bg magenta\|transparent`, `--size` | One still via gpt-image-1 |
| `motion` | `--image` (required), `--prompt` (required), `--out`, `--model`, `--image-field`, `--neg`, `--extra '{"duration":5}'` | Image-to-video via Replicate. `--model` defaults to `kwaivgi/kling-v2.1`; any Replicate image-to-video model works if you set `--image-field` to match its input schema |
| `extract` | `--video` (required), `--out`, `--fps`, `--contact`, `--cols`, `--thumb` | ffmpeg frame extraction. Requires `ffmpeg` on PATH. Omit `--fps` to keep every frame the clip has |
| `sheet` | `--framesDir` (required), `--pick` (required), `--out`, `--bg`, `--t0`, `--t1`, `--crop`, `--pad` | Chroma-key + assemble. `--bg` defaults to `255,0,255` (matches `seed`'s magenta); `--crop x,y,w,h` trims the source frame before keying if the clip has letterboxing or a watermark region to discard |

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

### sprite-generator verify <frame1> <frame2> [...]

Standalone identity-drift check — wraps [`verify-identity.js`](#verify-identityjs--frame-identity-checking)
as a CLI so you can gate frames from any source, not just this package's own pipelines. Exits non-zero
on failure (drift, or too few opaque pixels in a frame).

```bash
npx sprite-generator verify output/character/hero/frames/front-walk-0.png output/character/hero/frames/front-walk-1.png
```

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

## Templates

Genre starter packs. The installed package includes each manifest, a standalone `demo.html` that renders generated sprites in a representative scene, and a `capture.js` Playwright script. The repository also commits a `screenshot.png` for each template as visual proof without adding those large images to the npm tarball.

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
node node_modules/@pickbitsai/sprite-generator/templates/<name>/capture.js  # rebuild screenshot
```

Want to make your own template? Copy an existing `templates/<name>/` directory, tweak the manifest, adjust the demo layout, and submit a PR.

## Inspect the loop

[`loop.manifest.json`](loop.manifest.json) is the machine-readable workflow:
manifest and cost preview, model-assisted generation, deterministic background
cleanup and packing, an explicit human frame-selection interrupt, identity and
layout gates, and render proof. [docs/LOOP.md](docs/LOOP.md) is the human view.

Every deterministic gate has a known-good and known-bad fixture. Run the same
release boundary used in CI:

```bash
npm run preflight
```

That scans the exact npm publish set, runs the visual pipeline tests, packs the
tarball, installs it into a blank project, initializes a template, and executes
a dry run without sending an API request.

## What is deliberately not included

PickBits’ Asset Factory is the private production system that applies lessons
across a catalog of games. It contains operational history, game adapters,
provider operations, and the cross-catalog repair/harvest loop. It remains
proprietary.

This repository is its reusable public edge: generic generation, pose packing,
animation harvesting, templates, and visual verification. No production
manifest, game repository, account, or private asset corpus is required.

## License

MIT © Mark Pickering and PickBits.AI
