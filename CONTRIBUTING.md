# Contributing

## Development

Install the locked dependencies with npm, then run the same checks used by CI:

```sh
npm ci
npm run build
npm run check
```

The generated `dist/` directory is intentionally ignored. Do not commit it to
the default branch. Release automation builds it from reviewed source and adds
it only to generated release commits.
