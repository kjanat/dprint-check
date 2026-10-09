# dprint/check v3.1.0

This is the generated JavaScript Action package for [v3.1.0](https://github.com/kjanat/dprint-check/releases/tag/v3.1.0). It was built from source commit [`df42f71`](https://github.com/kjanat/dprint-check/commit/df42f71cba06a9f131a8814d4f5fbb8e69813e31).

## Usage

~~~yaml
- uses: kjanat/dprint-check@v3.1.0
~~~

## Provenance

- Bundle attestation: [view on GitHub](https://github.com/kjanat/dprint-check/attestations/54153837)
- Checksum manifest: [`SHA256SUMS`](https://github.com/kjanat/dprint-check/blob/v3.1.0/SHA256SUMS)
- Immutable release: [v3.1.0](https://github.com/kjanat/dprint-check/releases/tag/v3.1.0)
## Verify

~~~sh
release_dir="$(mktemp -d)"
test "$(gh release view v3.1.0 -R kjanat/dprint-check --json isDraft --jq .isDraft)" = false
test "$(gh api repos/kjanat/dprint-check/commits/v3.1.0 --jq .commit.verification.verified)" = true
mkdir -p "$release_dir/dist"
gh release download v3.1.0 -R kjanat/dprint-check --pattern SHA256SUMS --dir "$release_dir"
gh release download v3.1.0 -R kjanat/dprint-check --pattern main.mjs --dir "$release_dir/dist"
gh release download v3.1.0 -R kjanat/dprint-check --pattern post.mjs --dir "$release_dir/dist"
if command -v sha256sum >/dev/null; then
  (cd "$release_dir" && sha256sum --check SHA256SUMS)
else
  (cd "$release_dir" && shasum -a 256 --check SHA256SUMS)
fi
gh attestation verify "$release_dir/dist/main.mjs" --repo kjanat/dprint-check --source-digest df42f71cba06a9f131a8814d4f5fbb8e69813e31
gh attestation verify "$release_dir/dist/post.mjs" --repo kjanat/dprint-check --source-digest df42f71cba06a9f131a8814d4f5fbb8e69813e31
~~~