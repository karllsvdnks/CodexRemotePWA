# Changelog

All notable changes to this project are documented in this file.

## 0.0.3 - 2026-08-03

- Added the guided Windows configuration executable and first-run launcher flow.
- Added the signed Tailscale installer to the release package and removed provider-specific release wording.

## 0.0.2 - 2026-08-03

- Fixed a Windows console startup false-positive when Node needs longer than the initial probe to bind the local port.
- Added a portable Windows release ZIP build that excludes local configuration, conversation data, logs, and installed dependencies.

## 0.0.1 - 2026-08-03

Initial self-hosted release.

- Mobile PWA for manually approved local Codex tasks over Tailscale HTTPS.
- Dedicated API-provider Codex configuration without changing the Desktop App login.
- Remote thread persistence, approval controls, file upload, preview and download.
- Read-only Desktop history discovery plus append-only Desktop JSONL conversation mirroring.
- Manual Windows desktop console for PWA and Tailscale status and control.
- Deployment tutorial, client documentation and agent handoff documentation.
- GitHub CI, contribution guidance, security policy, and a completed installer skill.
