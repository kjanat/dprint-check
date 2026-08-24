# dprint/check v3.0.13

This is the generated JavaScript Action package for [v3.0.13](https://github.com/kjanat/dprint-check/releases/tag/v3.0.13). It was built from source commit [`7b6b3b1`](https://github.com/kjanat/dprint-check/commit/7b6b3b1e8970844380e3257bc59080ddae3d0cf5).

## Usage

~~~yaml
- uses: kjanat/dprint-check@v3.0.13
~~~

## Provenance

- Bundle attestation: [view on GitHub](https://github.com/kjanat/dprint-check/attestations/42519634)
- Checksum manifest: [`SHA256SUMS`](https://github.com/kjanat/dprint-check/blob/v3.0.13/SHA256SUMS)
- Immutable release: [v3.0.13](https://github.com/kjanat/dprint-check/releases/tag/v3.0.13)
## Verify

~~~sh
release_dir="$(mktemp -d)"
test "$(gh release view v3.0.13 -R kjanat/dprint-check --json isDraft --jq .isDraft)" = false
test "$(gh api repos/kjanat/dprint-check/commits/v3.0.13 --jq .commit.verification.verified)" = true
mkdir -p "$release_dir/dist"
gh release download v3.0.13 -R kjanat/dprint-check --pattern SHA256SUMS --dir "$release_dir"
gh release download v3.0.13 -R kjanat/dprint-check --pattern main.mjs --dir "$release_dir/dist"
gh release download v3.0.13 -R kjanat/dprint-check --pattern post.mjs --dir "$release_dir/dist"
if command -v sha256sum >/dev/null; then
  (cd "$release_dir" && sha256sum --check SHA256SUMS)
else
  (cd "$release_dir" && shasum -a 256 --check SHA256SUMS)
fi
gh attestation verify "$release_dir/dist/main.mjs" --repo kjanat/dprint-check --source-digest 7b6b3b1e8970844380e3257bc59080ddae3d0cf5
gh attestation verify "$release_dir/dist/post.mjs" --repo kjanat/dprint-check --source-digest 7b6b3b1e8970844380e3257bc59080ddae3d0cf5
~~~