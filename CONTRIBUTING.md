# Contributing

Sprite Generator is a generic toolkit. Contributions must not include real
credentials, private asset corpora, production manifests, workstation paths, or
code coupled to a particular game repository.

## Development

Requirements: Node.js 20 or newer.

```bash
npm install
npm test
npm run preflight
```

Tests create synthetic PNG fixtures locally and do not call image or video APIs.

## Evidence rules

- A dry run must not require a provider key or send a request.
- A visual gate must assert the pixels, dimensions, identity, or rendered state
  it claims to verify.
- Add both a passing fixture and a deliberately failing fixture for every new
  gate.
- A parser or scan that observes zero relevant items must report that absence;
  it must not produce a green pass that resembles measured success.
- Keep human selection explicit where aesthetic judgment cannot be reduced to a
  deterministic rule.

Open a focused pull request describing the behavior, the known-bad case, and the
commands used to verify it.
