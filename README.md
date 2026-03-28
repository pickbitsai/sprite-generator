# Sprite Generator

Agentic sprite generator using OpenAI's `gpt-image-1` model. Feed it a JSON manifest of assets and it generates consistent illustrated sprites with retry logic and concurrency control.

## Setup

```bash
cd tools/sprite-generator
npm install
```

## Usage

### 1. Build the manifest from game data

```bash
node build-manifest.js
```

This scans `cult-empire/gamedata.js` and outputs `manifest.json` with all 370+ assets categorized.

### 2. Generate sprites

```bash
OPENAI_API_KEY=sk-... node generate.js
```

Options:
- `--manifest <path>` — Path to manifest (default: `./manifest.json`)
- `--output <dir>` — Output directory (default: `./output`)
- `--style <prompt>` — Override the default style prompt
- `--size <WxH>` — `256x256`, `512x512`, or `1024x1024`
- `--category <name>` — Only generate one category (e.g. `creature`, `dungeon_enemy`)
- `--skip-existing` — Don't regenerate sprites that already exist
- `--concurrency <n>` — Parallel API requests (default: 3)
- `--dry-run` — Preview prompts without calling the API

Example — generate only creatures:
```bash
OPENAI_API_KEY=sk-... node generate.js --category creature --skip-existing
```

### 3. Preview results

```bash
node preview.js
# Opens http://localhost:3333
```

Shows all generated sprites in a grid, grouped by category, with missing assets highlighted.

## Manifest Format

```json
{
  "defaultStyle": "Dark fantasy illustrated sprite...",
  "assets": [
    {
      "id": "imp",
      "name": "Imp",
      "emoji": "👿",
      "category": "creature",
      "description": "A dark fantasy creature, Imp, menacing, supernatural"
    }
  ]
}
```

You can add custom `tags` arrays or override `description` per asset for more control.

## Reusing for Other Projects

1. Create a `manifest.json` with your assets
2. Set `defaultStyle` to match your game's art direction
3. Run the generator

The tool is project-agnostic — it just needs a manifest.

## License

MIT
