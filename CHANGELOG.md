# Changelog

All notable changes to this project are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
aims to follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
- Settings → *bwoc version*: check for updates and run an update via `BWOC_UPDATE_CMD`.
- Full-width footer.
- Standard community files: `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `SECURITY.md`, issue and PR templates, CI.

### Changed
- Gateway mesh has no built-in identity or relay; set `BWOC_GW_AGENT` and `BWOC_GW_RELAY` to enable it.
- Docker Compose project is named `fleet-manager`.

## [0.1.0]

- Initial public release under Apache-2.0.

[Unreleased]: https://github.com/bemindlabs/bwoc-fleet-manager/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/bemindlabs/bwoc-fleet-manager/releases/tag/v0.1.0
