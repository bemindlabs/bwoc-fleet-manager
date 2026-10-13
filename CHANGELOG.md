# Changelog

All notable changes to this project are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
aims to follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.2.0] - 2026-10-14

### Added
- Settings → *bwoc version*: check for updates and run an update via `BWOC_UPDATE_CMD`.
- Full-width footer.
- Standard community files: `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `SECURITY.md`, issue and PR templates, CI.

### Changed
- Gateway mesh has no built-in identity or relay; set `BWOC_GW_AGENT` and `BWOC_GW_RELAY` to enable it.
- Docker Compose project is named `fleet-manager`.
- Declared Node floor is 22.12 (required by Vite 8 and concurrently 10).

### Security
- Sub-paths forwarded to the host sidecar (`/api/root/*`, `/api/gateway/*`) are validated segment by segment and must stay on the sidecar origin under their prefix.
- Unexpected server errors no longer return their message to the caller; it goes to the server log. `bwoc` failures and 4xx messages are unchanged.

## [0.1.0]

- Initial public release under Apache-2.0.

[Unreleased]: https://github.com/bemindlabs/bwoc-fleet-manager/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/bemindlabs/bwoc-fleet-manager/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/bemindlabs/bwoc-fleet-manager/releases/tag/v0.1.0
