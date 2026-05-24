# Changelog

All notable changes to DSME are documented here.

## [2.1.0] - 2026-05-24

### Added
- Open-source docs: `CONTRIBUTING.md`, `SECURITY.md`, `LICENSE`, GitHub CI workflow
- Shared modules: `text-tool-parser`, `tool-display`, `ax-snapshot-format`, `command-guard`
- Unit tests for browser timeline, search formatting, token limits, command guard, snapshot/parser

### Changed
- README aligned with AI web automation agent (not IDE)
- CDP proxy binds to `127.0.0.1` only
- `test:ci` runs typecheck, lint, unit tests, and production build

### Security
- Documented local-first threat model in `SECURITY.md`
- Minimal destructive-command blocklist for `run_command`
