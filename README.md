# dprint check action

This action installs dprint, caches the plugin store, then runs `dprint check`. Binary caching is optional.
Formatting failures are emitted as GitHub file annotations while retaining dprint's diff in the job log.
Set `annotations` to `false` to retain only the job-log output.

## Usage

1. Checkout your repo.
2. Run the `kjanat/dprint-check` action.

```yml
jobs:
  style:
    runs-on: ubuntu-latest
    permissions: { contents: read }
    steps: [uses: actions/checkout@v7, uses: kjanat/dprint-check@v3]
```

The plugin cache is enabled by default. Its key includes the release repository, dprint version, runner target (including Linux libc), and the
contents of every root and inherited dprint config. The action warms the plugins after a cache miss so the following
dprint invocation does not compile them.

Binary caching is disabled by default. Set `cache-binary: true` to opt in. It controls both tool-cache and Actions
binary-cache reads and writes independently of plugin caching.

To disable only plugin caching:

```yml
- uses: kjanat/dprint-check@v3
  with: { cache: false }
```

To cache the binary while disabling plugin caching:

```yml
- uses: kjanat/dprint-check@v3
  with: { cache: false, cache-binary: true }
```

GitHub Enterprise Server does not provide the cache service this action uses.
On GHES the action installs dprint without caching.

### Install only

Set `install-only` to `true` to install dprint and populate its caches without checking formatting. The installed binary is
added to `PATH` for later steps.

```yml
- uses: kjanat/dprint-check@v3
  with: { install-only: true }
- run: dprint fmt
```

File annotations are only emitted for the check the action runs itself; a `dprint check` in a later step prints its
regular output without annotations.

### PR formatting review

Set `review: true` to publish one PR review containing inline, applyable formatting suggestions across files and
line ranges. Check out the PR head so the reviewed text and suggestion coordinates match:

```yml
jobs:
  style:
    runs-on: ubuntu-latest
    permissions: { contents: read, pull-requests: write }
    steps:
      - uses: actions/checkout@v7
        with: { ref: "${{ github.event.pull_request.head.sha }}" }
      - uses: kjanat/dprint-check@v3
        with: { review: true }
```

The action probes the installed binary's `check --help`. When JSON unified diffs are supported, it collects
`dprint check --diff-format unified --json` output from every config root and submits all suggestions together.
Older binaries retain the regular check and annotations; the review is skipped. `--list-different` cannot be used
with a supported review because it suppresses replacement text.

Suggestions are limited to commentable PR ranges and files unchanged from the checked-out PR head. Insertions
retain adjacent context; deletions and multi-line replacements preserve exact replacement lines. Conflicting
config results, line-ending-only changes, and changes involving a missing final newline are not offered as
inline suggestions. Run `dprint fmt` for the complete result.

Before posting, the action checks every existing PR review thread, including threads from earlier commits. An
unresolved, current dprint suggestion suppresses a duplicate only when the file, current line range, and replacement
text match. Covered ranges also skip repeated workflow annotations. New or changed suggestions are grouped into
one review; when every suggestion is covered, no new review is posted. Resolved, outdated, deleted, and unrelated
review comments do not suppress suggestions.

Publication or thread lookup failures retain the original formatting result and workflow annotations. No review is
posted for clean checks, non-PR events, or `install-only: true`.

### Version

Releases come from `kjanat/dprint` by default. To install upstream dprint:

```yml
- uses: kjanat/dprint-check@v3
  with: { repository: dprint/dprint }
```

`repository` accepts a GitHub `owner/repo`. Binary and plugin caches, tool-cache entries, and installation paths are
scoped to that repository. It must publish compatible dprint ZIP assets and SHA-256 digests or `SHASUMS256.txt`.
`dprint-version` accepts an exact release tag, including fork and prerelease tags, without rewriting it. `latest`
selects the repository's latest stable release.

By default, the action discovers the latest dprint release and selects the published ZIP matching the runner. To use a
specific release:

```yml
- uses: kjanat/dprint-check@v3
  with: { dprint-version: 0.58.0-kjanat }
```

Downloads are verified with the asset's SHA-256 digest. For older releases without asset digests, the action discovers
and uses the release's `SHASUMS256.txt` asset. Releases without either are rejected before downloading the binary; in
dprint's published release history, this means versions before `0.14.0` cannot be installed by this action.

### Config path

Configuration discovery checks `dprint.json`, `dprint.jsonc`, `.dprint.json`, `.dprint.jsonc`, `dprint.toml`, and
`.dprint.toml`, in that root-config priority order. TOML configurations support inherited local and remote configs,
including mixed JSON/TOML graphs. An existing `DPRINT_CACHE_DIR` is used as the cache root with a subdirectory per
release repository.

`config-path` also accepts a local path, glob, or remote HTTP(S)
URL:

```yml
- uses: kjanat/dprint-check@v3
  with: { config-path: https://raw.githubusercontent.com/example/configs/HEAD/dprint.json }
```

To check multiple explicit configurations, separate paths, globs, or URLs with line breaks, tabs, or `|`. Each
resolved configuration is checked separately:

```yml
- uses: kjanat/dprint-check@v3
  with:
    config-path: |
      https://raw.githubusercontent.com/example1/configs/HEAD/dprint.json
      https://raw.githubusercontent.com/example2/configs/HEAD/dprint.json
```

The cache key follows `extends` recursively, including string or array values and relative links between local or
remote configs. Mutable remote configs are fetched before cache selection and refreshed before plugin warmup. When a
remote configuration graph contains a process plugin or a local-directory template, the action materializes that graph
in the workspace before warmup and checking. This deliberately treats that remote configuration as locally trusted,
allowing process plugins that dprint otherwise ignores for remote configurations.

### Args

To pass additional arguments to `dprint check`, pass them to the `args` input.
E.g. to only check changed files:

```yml
- name: Get changed files
  id: changed-files
  uses: tj-actions/changed-files@v45
- uses: kjanat/dprint-check@v3
  with: { args: "--allow-no-files ${{ steps.changed-files.outputs.all_changed_files }}" }
```

## Inputs

| Input            | Default         | Description                                           |
| ---------------- | --------------- | ----------------------------------------------------- |
| `dprint-version` | latest          | dprint release to install                             |
| `repository`     | `kjanat/dprint` | GitHub repository containing dprint releases          |
| `token`          | `github.token`  | Used for release metadata and optional PR reviews     |
| `cache`          | `true`          | Cache the plugin store (`DPRINT_CACHE_DIR`)           |
| `cache-binary`   | `false`         | Cache the binary via tool-cache and Actions cache     |
| `install-only`   | `false`         | Install without running `dprint check`                |
| `config-path`    | auto-discovered | Config path(s), glob(s), or HTTP(S) URL(s)            |
| `annotations`    | `true`          | Emit annotations for formatting failures              |
| `review`         | `false`         | Post one PR review with inline formatting suggestions |
| `args`           |                 | Additional arguments passed to `dprint check`         |

## Outputs

| Output             | Description                                          |
| ------------------ | ---------------------------------------------------- |
| `version`          | Installed dprint version                             |
| `location`         | Absolute path to the installed binary                |
| `cache-hit`        | Whether the binary was restored from cache           |
| `plugin-cache-hit` | Whether the exact compiled-plugin cache was restored |
| `plugin-cache-key` | Cache key for the compiled plugins                   |

## Troubleshooting

### Windows line endings

When running on Windows, you may get a lot of messages like:

```plaintext
from D:\a\check\check\README.md:
 | Text differed by line endings.
--
```

This is because unfortunately git is configured in GH actions to check out line
endings as CRLF (`\r\n`).

You can fix this by only running the action on Linux as shown above (recommended),
or to do the following before checking out the repo:

```yml
- name: Ensure LF line endings for Windows
  run: |
    git config --global core.autocrlf false
    git config --global core.eol lf

# or use our re-useable action to do this for you:
- uses: kjanat/dprint-check/actions/git-lf@v3

- uses: actions/checkout@v7
```
