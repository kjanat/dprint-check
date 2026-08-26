# dprint/check v3.0.15

This is the generated JavaScript Action package for [v3.0.15](https://github.com/kjanat/dprint-check/releases/tag/v3.0.15). It was built from source commit [`589482e`](https://github.com/kjanat/dprint-check/commit/589482e792ff2f05cca37a5e071a5c204016aa79).

## Usage

~~~yaml
- uses: kjanat/dprint-check@v3.0.15
~~~

## Provenance

- Bundle attestation: [view on GitHub](https://github.com/kjanat/dprint-check/attestations/43093914)
- Checksum manifest: [`SHA256SUMS`](https://github.com/kjanat/dprint-check/blob/v3.0.15/SHA256SUMS)
- Immutable release: [v3.0.15](https://github.com/kjanat/dprint-check/releases/tag/v3.0.15)
## Verify

~~~sh
release_dir="$(mktemp -d)"
test "$(gh release view v3.0.15 -R kjanat/dprint-check --json isDraft --jq .isDraft)" = false
test "$(gh api repos/kjanat/dprint-check/commits/v3.0.15 --jq .commit.verification.verified)" = true
mkdir -p "$release_dir/dist"
gh release download v3.0.15 -R kjanat/dprint-check --pattern SHA256SUMS --dir "$release_dir"
gh release download v3.0.15 -R kjanat/dprint-check --pattern main.mjs --dir "$release_dir/dist"
gh release download v3.0.15 -R kjanat/dprint-check --pattern post.mjs --dir "$release_dir/dist"
if command -v sha256sum >/dev/null; then
  (cd "$release_dir" && sha256sum --check SHA256SUMS)
else
  (cd "$release_dir" && shasum -a 256 --check SHA256SUMS)
fi
gh attestation verify "$release_dir/dist/main.mjs" --repo kjanat/dprint-check --source-digest 589482e792ff2f05cca37a5e071a5c204016aa79
gh attestation verify "$release_dir/dist/post.mjs" --repo kjanat/dprint-check --source-digest 589482e792ff2f05cca37a5e071a5c204016aa79
~~~