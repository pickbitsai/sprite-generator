# Sprite Generator

Agentic sprite generator using OpenAI's `gpt-image-1` model. Feed it a JSON manifest of assets and it generates consistent illustrated sprites with retry logic and concurrency control.

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

### sprite-preview [options]

| Option | Default | Description |
|--------|---------|-------------|
| `--manifest <path>` | `./manifest.json` | Path to manifest JSON |
| `--output <dir>` | `./output` | Directory with generated sprites |
| `--port <n>` | `3333` | Server port |

## Manifest Format

```json
{
  "defaultStyle": "Illustrated game sprite, transparent background, 256x256, detailed, centered composition, no text",
  "assets": [
    {
      "id": "unique_id",
      "name": "Display Name",
      "emoji": "🎮",
      "category": "characters",
      "description": "Detailed description for the AI prompt",
      "tags": ["optional", "keywords"]
    }
  ]
}
```

- **`defaultStyle`** — Prepended to every asset's prompt. Sets the overall art direction.
- **`id`** — Unique identifier, used as the filename (`<id>.png`).
- **`category`** — Groups assets into subdirectories under the output folder.
- **`description`** — The main prompt content. Be specific about the subject, pose, style.
- **`tags`** — Optional keywords appended to the prompt.

## Examples

See the `examples/` directory for real-world manifests and manifest builders from actual game projects.

## Requirements

- Node.js 18+
- OpenAI API key with `gpt-image-1` access

## License

MIT
