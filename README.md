# Sprite Generator

Generate game sprites with AI from a JSON manifest. Describe your assets, run the CLI, and get consistent illustrated PNGs — including sprite sheets with multiple angles and animation frames.

## What You Need

- **Node.js 18+**
- **An OpenAI API key** with access to `gpt-image-1` (set as `OPENAI_API_KEY` environment variable)

## Getting Started

### 1. Install

```bash
npm install mrpickering/sprite-generator
```

### 2. Create a manifest

```bash
npx sprite-generator init
```

This creates a `manifest.json` in your project with a starter template. Open it up — it has two key parts:

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

## Examples

See the `examples/` directory for real-world manifests from actual game projects with hundreds of assets.

## License

MIT
