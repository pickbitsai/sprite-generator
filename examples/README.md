# Examples

These are project-specific manifest builders and pre-built manifests from real games.

## Files

- **`cult-empire-manifest.json`** — 370+ assets for a dark fantasy game
- **`cat-snack-bar-manifest.json`** — 550+ assets for a cat cafe game
- **`build-manifest.js`** — Scans cult-empire game data and builds a manifest
- **`build-cat-manifest.js`** — Scans cat-snack-bar game data and builds a manifest
- **`netrunner/`** — full directional-animation bundle for a cyberpunk dungeon crawler (4 classes, programmatic manifest builder, and a Gemini-based sheet generator). See `netrunner/README.md`.

## Notes

The build scripts reference hardcoded paths to their respective game data files (e.g., `../../cult-empire/gamedata.js`). Adapt them for your own project or just create a manifest JSON by hand.

See the main README for the manifest format.
