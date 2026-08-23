# Contributing

## Development

Install the locked dependencies with Bun 1.4.0, then run the same checks used by CI:

```sh
bun install --frozen-lockfile
bun run build
bun run check
```

The generated `dist/` directory is intentionally ignored. Do not commit it to
the default branch. Release automation builds it from reviewed source and adds
it only to generated release commits.

## Updating Bun

To update the repository's pinned Bun version:

```sh
bun upgrade --stable
bun pm pkg set "packageManager=bun@$(bun --version)"
bun install
bun run build
bun run check
```

## Release references

Each release provides three update policies:

| Reference | Meaning                        | Mutable |
| --------- | ------------------------------ | ------- |
| `v3.2.1`  | Exact, immutable release       | No      |
| `v3.2`    | Latest stable `v3.2.x` release | Yes     |
| `v3`      | Latest stable `v3.x.y` release | Yes     |

The major and minor aliases advance independently. A backport such as `v3.2.2`
may advance `v3.2` while leaving a newer `v3` release unchanged. Never create a
GitHub Release for a floating alias; release immutability would prevent that tag
from moving.

## Repository settings

Configure the repository before publishing a release:

| Setting                                                  | Required state                     |
| -------------------------------------------------------- | ---------------------------------- |
| GitHub Actions                                           | Enabled                            |
| Release immutability                                     | Enabled                            |
| Default workflow permissions                             | Restricted/read-only is sufficient |
| Allow GitHub Actions to create and approve pull requests | Disabled                           |
| Send write tokens to workflows from pull requests        | Disabled                           |

The workflow grants each job only the `GITHUB_TOKEN` permissions it needs.
It does not require a personal access token or repository secret. Artifact
attestations must be available; on GitHub Free, Pro, and Team they require a
public repository.

Tag rules must allow the release publisher to create exact `vX.Y.Z` tags.
Floating `vX.Y` and `vX` tags are created or updated by `github-actions[bot]`
using the job-scoped `GITHUB_TOKEN`. Any ruleset covering those names must
permit those updates; otherwise release finalization fails closed. Do not add
a broader bypass merely to make the workflow pass.

See GitHub's documentation for [immutable releases], [artifact attestations],
[`GITHUB_TOKEN` permissions], and [tag ruleset bypasses].

## Publishing a release

1. Update `package.json` to the intended stable semantic version and merge it
   into the default branch.

   ```sh
   bun pm version patch --no-git-tag-version
   # Or: minor, major, or an explicit version such as 3.1.0
   ```

2. Confirm CI is green and the default-branch HEAD has a verified signature.
3. Manually dispatch the `Release` workflow on the default branch with the
   matching `vX.Y.Z` version, either from the Actions page or with GitHub CLI:

   ```sh
   gh workflow run release.yml --ref main -f version=vX.Y.Z
   ```

   This workflow dispatch is the only supported way to prepare a release. It
   creates a draft but does not publish it. Dispatch each version only once;
   an existing draft or release with that version blocks preparation.
4. Wait for the workflow to create the draft release. It builds and attests the
   bundle, independently rebuilds it, and creates a signed release commit whose
   complete tree contains only:

   ```text
   action.yml
   SHA256SUMS
   dist/<every bundle path listed in SHA256SUMS>
   ```

5. Follow the workflow summary's **Review and publish** link. Confirm that `SHA256SUMS` and every
   bundle named by it are attached. Do not replace them or change the target
   commit. Confirm release immutability is enabled, then publish the draft
   through GitHub's release UI. Do not dispatch the workflow again. Publishing
   the draft automatically triggers the final verification phase of the
   `Release` workflow.
6. Wait for the release-triggered verification job. It verifies the immutable
   release, signed single-parent release commit, complete package tree, checksums,
   provenance, independent rebuild, and published checksum asset before moving
   eligible floating tags.
7. Verify the completed workflow and release:

   ```sh
   gh release verify vX.Y.Z
   gh release view vX.Y.Z
   ```

Do not create or move release tags manually. If draft preparation fails, inspect
the failed job before retrying, and do not retry the same version while a draft
exists. If post-publication verification fails, leave the floating tags
unchanged, investigate the failure, and do not bypass the verification job.

[immutable releases]: https://docs.github.com/en/code-security/how-tos/secure-your-supply-chain/establish-provenance-and-integrity/prevent-release-changes
[artifact attestations]: https://docs.github.com/en/actions/how-tos/secure-your-work/use-artifact-attestations/use-artifact-attestations
[`github_token` permissions]: https://docs.github.com/en/actions/tutorials/authenticate-with-github_token
[tag ruleset bypasses]: https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/creating-rulesets-for-a-repository#granting-bypass-permissions-for-your-branch-or-tag-ruleset
