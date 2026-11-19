# Contributing to Meru Mind

Thank you for contributing!

## Development

```bash
pnpm install
pnpm typecheck
pnpm build
pnpm test
pnpm run check:oss
```

## Guidelines

- Keep the core engine free of vendor-specific cloud SDKs; add new storage or embedding providers behind `src/ports.ts`.
- All tests must run in isolated temporary directories (`os.tmpdir()`) using synthetic data.
- Never commit `.sqlite` files, `.env` files, personal paths, or credentials. Run `pnpm run check:oss` before opening a pull request.
