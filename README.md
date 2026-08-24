# dprint/check v3.0.12

This is the generated JavaScript Action package for [v3.0.12](https://github.com/kjanat/dprint-check/releases/tag/v3.0.12). It was built from source commit [`1a155d4`](https://github.com/kjanat/dprint-check/commit/1a155d4fc5da47b3ca16b4ddf3d51081d67e3aa4).

## Usage

~~~yaml
- uses: kjanat/dprint-check@v3.0.12
~~~

## Provenance

- Bundle attestation: [view on GitHub](https://github.com/kjanat/dprint-check/attestations/42515029)
- Checksum manifest: [`SHA256SUMS`](https://github.com/kjanat/dprint-check/blob/v3.0.12/SHA256SUMS)
- Immutable release: [v3.0.12](https://github.com/kjanat/dprint-check/releases/tag/v3.0.12)
## Verify

~~~sh
gh release verify v3.0.12 -R kjanat/dprint-check
gh attestation verify dist/main.mjs --repo kjanat/dprint-check --source-digest 1a155d4fc5da47b3ca16b4ddf3d51081d67e3aa4
gh attestation verify dist/post.mjs --repo kjanat/dprint-check --source-digest 1a155d4fc5da47b3ca16b4ddf3d51081d67e3aa4
~~~