# Sprite Generator

This is an npm package for generating game sprites using OpenAI's image models. Install it from GitHub and use the CLI to generate sprites from a JSON manifest.

## Installation

```bash
npm install mrpickering/sprite-generator
```

## Workflow

1. Run `npx sprite-generator init` to create a starter `manifest.json`
2. Edit `manifest.json`:
   - Set `defaultStyle` to define the art direction (e.g., "Pixel art sprite, transparent background, 64x64, retro game style")
   - Add entries to the `assets` array — each needs `id`, `name`, `emoji`, `category`, `description`
3. Preview prompts first: `OPENAI_API_KEY=$OPENAI_API_KEY npx sprite-generator --dry-run`
4. Generate sprites: `OPENAI_API_KEY=$OPENAI_API_KEY npx sprite-generator`
5. Use `--skip-existing` to resume interrupted runs
6. Use `--category <name>` to generate one category at a time
7. Preview results: `npx sprite-preview` (opens http://localhost:3333)

## Manifest Format

```json
{
  "defaultStyle": "Your art style description, transparent background, size, no text",
  "assets": [
    {
      "id": "fire_sword",
      "name": "Fire Sword",
      "emoji": "🗡️",
      "category": "weapon",
      "description": "A flaming sword with a golden hilt, glowing orange blade",
      "tags": ["weapon", "fire", "rare"]
    }
  ]
}
```

## Sprite Sheets (Angles + Animations)

For characters or objects that need multiple views and animation frames, add `angles` and `animations` to the manifest (globally or per asset):

```json
{
  "defaultStyle": "Pixel art sprite, transparent background, 64x64",
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
        "attack": { "frames": 3, "fps": 10, "frameDescriptions": ["raising sword", "mid-swing", "follow-through"] }
      }
    }
  ]
}
```

This generates individual frame PNGs and assembles them into a sprite sheet (`hero-sheet.png`) with metadata (`hero-sheet.json`).

Output structure:
```
output/<category>/<id>/frames/<angle>-<animation>-<frame>.png
output/<category>/<id>/<id>-sheet.png
output/<category>/<id>/<id>-sheet.json
```

The metadata JSON includes `frameWidth`, `frameHeight`, `columns`, `rows`, `animations` (with fps), and a `frameMap` array mapping each cell to its angle/animation/frame. Works with Phaser, Godot, Unity, etc.

Use `--no-sheet` to generate individual frames without assembling the sheet.

## Tips

- `defaultStyle` is the most important field — it controls consistency across all sprites. Be specific about: art style, background (usually "transparent background"), composition, and what to avoid (usually "no text").
- Asset `description` is combined with `defaultStyle` to form the full prompt. Focus on what makes this asset unique.
- Start with a small category and `--dry-run` to validate the style before generating everything.
- Use `--concurrency 5` to speed up large batches (default is 3).
- Output goes to `./output/<category>/<id>.png` by default (or `./output/<category>/<id>/` for sprite sheets).
- Built-in animation phase descriptions exist for: idle, walk, run, attack, jump, death. For custom animations, provide `frameDescriptions` in the manifest.
