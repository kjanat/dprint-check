# dprint check action

This action installs dprint, then runs `dprint check` and fails the build if something is not properly formatted.

## Usage

1. Checkout your repo.
2. Run the `dprint/check` action.

```yml
jobs:
  style:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: dprint/check@v3
```

### Version

By default, the action discovers the latest dprint release and selects the published ZIP matching the runner. To use a
specific release:

```yml
- uses: dprint/check@v3
  with: { dprint-version: 0.30.3 }
```

Downloads are verified with the asset's SHA-256 digest. For older releases without asset digests, the action discovers
and uses the release's `SHASUMS256.txt` asset. Releases without either are rejected before downloading the binary; in
dprint's published release history, this means versions before `0.14.0` cannot be installed by this action.

### Config path

By default, dprint auto-discovers its configuration. `config-path` also accepts a local path, glob, or remote HTTP(S)
URL:

```yml
- uses: dprint/check@v3
  with:
    config-path: https://raw.githubusercontent.com/example/configs/HEAD/dprint.json
```

To check multiple explicit configurations, separate paths, globs, or URLs with line breaks, tabs, or `|`. Each
resolved configuration is checked separately:

```yml
- uses: dprint/check@v3
  with:
    config-path: |
      https://raw.githubusercontent.com/example1/configs/HEAD/dprint.json
      https://raw.githubusercontent.com/example2/configs/HEAD/dprint.json
```

### Args

To pass additional arguments to `dprint check`, pass them to the `args` input.
E.g. to only check changed files:

```yml
- name: Get changed files
  id: changed-files
  uses: tj-actions/changed-files@v45
- uses: dprint/check@v3
  with:
    args: >-
      --allow-no-files
      ${{ steps.changed-files.outputs.all_changed_files }}
```

## Inputs

| Input            | Default         | Description                                   |
| ---------------- | --------------- | --------------------------------------------- |
| `dprint-version` | latest          | dprint release to install                     |
| `token`          | `github.token`  | Token used to query GitHub release metadata   |
| `config-path`    | auto-discovered | Config path(s), glob(s), or HTTP(S) URL(s)    |
| `args`           |                 | Additional arguments passed to `dprint check` |

## Outputs

| Output     | Description                           |
| ---------- | ------------------------------------- |
| `version`  | Installed dprint version              |
| `location` | Absolute path to the installed binary |

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
- uses: dprint/check/actions/git-lf@v3

- uses: actions/checkout@v7
```
