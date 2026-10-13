# Security policy

Security fixes are applied to the latest version on the default branch.

Report vulnerabilities through GitHub Private Vulnerability Reporting when
available, or through a private contact method on the maintainer’s GitHub
profile. Do not open a public issue containing an API key, private image, model
response, production manifest, or unpublished game asset.

## Trust and cost boundary

The package reads local manifests and images, writes generated media, and can
send prompts or reference images to configured model providers.

- `--dry-run` does not call a provider.
- `generate`, `pack`, and `animate seed` can spend image-generation credits.
- `animate motion` uploads the selected seed image to the configured Replicate
  model and can spend video-generation credits.
- `animate extract`, `animate sheet`, `verify`, and the deterministic processing
  stages run locally.
- The preview server binds locally and serves generated assets from disk.

Use synthetic or approved reference material. Review each provider’s retention
and data-use terms before uploading confidential images.
