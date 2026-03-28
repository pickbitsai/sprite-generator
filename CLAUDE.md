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

## Tips

- `defaultStyle` is the most important field — it controls consistency across all sprites. Be specific about: art style, background (usually "transparent background"), composition, and what to avoid (usually "no text").
- Asset `description` is combined with `defaultStyle` to form the full prompt. Focus on what makes this asset unique.
- Start with a small category and `--dry-run` to validate the style before generating everything.
- Use `--concurrency 5` to speed up large batches (default is 3).
- Output goes to `./output/<category>/<id>.png` by default.
