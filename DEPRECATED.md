# DEPRECATED — moved into the monorepo (2026-07-13)

This directory is **superseded**. It now lives at:

    C:\new\asset-factory\packages\sprite-generator

Folded in via `git subtree`, so **the full history came with it**. The GitHub remote
(github.com/MrPickering/sprite-generator) is untouched and still has every commit.

`node_modules/`, `sprite-generator-2.0.0.tgz` and `test-results/` were MOVED to the new path
(git could not carry them — all three are gitignored/untracked, and ~40 scripts plus two games'
`package.json` `file:` dependencies resolve them by absolute path).

**Nothing references this directory any more.** Safe to delete:

    rm -rf C:\new\sprite-generator
