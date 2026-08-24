# dprint/check v3.0.14

This is the generated JavaScript Action package for [v3.0.14](https://github.com/kjanat/dprint-check/releases/tag/v3.0.14). It was built from source commit [`4ab88c4`](https://github.com/kjanat/dprint-check/commit/4ab88c49637b83dc363b6d8ac7920f72659e4b04).

## Usage

~~~yaml
- uses: kjanat/dprint-check@v3.0.14
~~~

## Provenance

- Bundle attestation: [view on GitHub](https://github.com/kjanat/dprint-check/attestations/42521633)
- Checksum manifest: [`SHA256SUMS`](https://github.com/kjanat/dprint-check/blob/v3.0.14/SHA256SUMS)
- Immutable release: [v3.0.14](https://github.com/kjanat/dprint-check/releases/tag/v3.0.14)
## Verify

~~~sh
release_dir="$(mktemp -d)"
test "$(gh release view v3.0.14 -R kjanat/dprint-check --json isDraft --jq .isDraft)" = false
test "$(gh api repos/kjanat/dprint-check/commits/v3.0.14 --jq .commit.verification.verified)" = true
mkdir -p "$release_dir/dist"
gh release download v3.0.14 -R kjanat/dprint-check --pattern SHA256SUMS --dir "$release_dir"
gh release download v3.0.14 -R kjanat/dprint-check --pattern main.mjs --dir "$release_dir/dist"
gh release download v3.0.14 -R kjanat/dprint-check --pattern post.mjs --dir "$release_dir/dist"
if command -v sha256sum >/dev/null; then
  (cd "$release_dir" && sha256sum --check SHA256SUMS)
else
  (cd "$release_dir" && shasum -a 256 --check SHA256SUMS)
fi
gh attestation verify "$release_dir/dist/main.mjs" --repo kjanat/dprint-check --source-digest 4ab88c49637b83dc363b6d8ac7920f72659e4b04
gh attestation verify "$release_dir/dist/post.mjs" --repo kjanat/dprint-check --source-digest 4ab88c49637b83dc363b6d8ac7920f72659e4b04
~~~