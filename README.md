# dprint/check v3.0.11

This is the generated JavaScript Action package for [v3.0.11](https://github.com/kjanat/dprint-check/releases/tag/v3.0.11). It was built from source commit [`a93844b`](https://github.com/kjanat/dprint-check/commit/a93844b67f255e857480c4b3ca70a3772a9d7c6f).

## Usage

~~~yaml
- uses: kjanat/dprint-check@v3.0.11
~~~

## Provenance

- Bundle attestation: [view on GitHub](https://github.com/kjanat/dprint-check/attestations/42501059)
- Checksum manifest: [`SHA256SUMS`](https://github.com/kjanat/dprint-check/blob/v3.0.11/SHA256SUMS)
- Immutable release: [v3.0.11](https://github.com/kjanat/dprint-check/releases/tag/v3.0.11)
## Verify

~~~sh
gh release verify v3.0.11 -R kjanat/dprint-check
gh attestation verify dist/main.mjs --repo kjanat/dprint-check --source-digest a93844b67f255e857480c4b3ca70a3772a9d7c6f
gh attestation verify dist/post.mjs --repo kjanat/dprint-check --source-digest a93844b67f255e857480c4b3ca70a3772a9d7c6f
~~~