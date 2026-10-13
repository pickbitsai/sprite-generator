# Sprite Generator contributor notes

This repository is the reusable public edge of a private production system.

- Keep it game-agnostic. Do not add production manifests, game-specific paths,
  credentials, private provider operations, or proprietary asset corpora.
- Keep API calls behind explicit CLI stages. Dry runs must never spend credits.
- File existence is not visual proof. Gates must inspect pixels, dimensions, or
  a rendered result.
- Every gate must have a known-good and known-bad fixture that proves it can
  reject.
- `pack` preserves the target engine’s declared dimensions and anchors.
- `animate` pauses after frame extraction because selecting useful motion
  frames is an explicit human judgment.
- Run `npm run preflight` after changing the package boundary or visual pipeline.
- Update `loop.manifest.json` and `docs/LOOP.md` when the executable workflow
  changes.
