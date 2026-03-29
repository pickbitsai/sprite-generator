# Sprite Generator

Agentic sprite generator using OpenAI's `gpt-image-1` model. Feed it a JSON manifest of assets and it generates consistent illustrated sprites with retry logic and concurrency control. Supports sprite sheets with multiple angles and animation frames.

## Install

```bash
npm install mrpickering/sprite-generator
```

## Quick Start

```bash
# Create a starter manifest in your project
npx sprite-generator init

# Edit manifest.json to describe your sprites, then preview prompts
OPENAI_API_KEY=sk-... npx sprite-generator --dry-run

# Generate all sprites
OPENAI_API_KEY=sk-... npx sprite-generator

# View results in the browser
npx sprite-preview
```

## CLI Reference

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

## Manifest Format

### Simple Sprites

```json
{
  "defaultStyle": "Illustrated game sprite, transparent background, 256x256, detailed, no text",
  "assets": [
    {
      "id": "health_potion",
      "name": "Health Potion",
      "emoji": "🧪",
      "category": "item",
      "description": "A glowing red potion in a glass flask",
      "tags": ["item", "consumable", "healing"]
    }
  ]
}
```

Output: `output/item/health_potion.png`

### Sprite Sheets (Angles + Animations)

Add `angles` and `animations` globally or per asset:

```json
{
  "defaultStyle": "Pixel art sprite, transparent background, 64x64, retro game style",
  "angles": ["front", "back", "left", "right"],
  "animations": {
    "idle": { "frames": 2, "fps": 4 },
    "walk": { "frames": 4, "fps": 8 }
  },
  "assets": [
    {
      "id": "hero",
      "name": "Hero",
      "emoji": "🦸",
      "category": "character",
      "description": "A knight in silver armor with a blue cape",
      "angles": ["front", "side"],
      "animations": {
        "idle": { "frames": 2, "fps": 4 },
        "walk": { "frames": 4, "fps": 8 },
        "attack": {
          "frames": 3,
          "fps": 10,
          "frameDescriptions": ["raising sword", "mid-swing", "follow-through"]
        }
      }
    }
  ]
}
```

Output:
```
output/character/hero/
  frames/
    front-idle-0.png, front-idle-1.png
    front-walk-0.png, front-walk-1.png, ...
    side-idle-0.png, side-idle-1.png
    ...
  hero-sheet.png       # assembled sprite sheet
  hero-sheet.json      # metadata for game engines
```

The metadata JSON contains `frameWidth`, `frameHeight`, `columns`, `rows`, `animations` (with fps), and a `frameMap` array mapping each grid cell to its angle, animation, and frame index.

### Field Reference

- **`defaultStyle`** — Prepended to every prompt. Sets overall art direction.
- **`angles`** — Array of view directions (e.g., `["front", "back", "left", "right"]`). Per-asset overrides replace global.
- **`animations`** — Object keyed by name. Each has `frames` (count), `fps` (playback speed), optional `frameDescriptions`.
- **`id`** — Unique identifier, used as filename.
- **`category`** — Groups assets into subdirectories.
- **`description`** — Main prompt content. Be specific.
- **`tags`** — Optional keywords appended to prompt.

Built-in animation phase descriptions: `idle`, `walk`, `run`, `attack`, `jump`, `death`. For custom animations, provide `frameDescriptions`.

## Examples

See the `examples/` directory for real-world manifests and manifest builders from actual game projects.

## Requirements

- Node.js 18+
- OpenAI API key with `gpt-image-1` access

## License

MIT
