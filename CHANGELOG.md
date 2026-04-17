# Changelog
All notable changes to this project will be documented in this file.
Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
This project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.0] - 2026-04-16
### Added
- Initial release: pluggable credential providers for Node.
- EnvVarProvider, FileProvider, KeychainProvider (macOS/Linux), CloudSecretsProvider (AWS/GCP/Azure).
- `parseCredentialRef` for `provider:key` reference strings.
- `resolveSecret(name, {provider, fallback})` chain helper.
