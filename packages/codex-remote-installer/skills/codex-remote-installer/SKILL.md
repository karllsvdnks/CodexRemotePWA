---
name: codex-remote-installer
description: Install, repair, or maintain a self-hosted Codex Remote PWA on Windows with a manual-start local service, a dedicated API-provider Codex configuration, and Tailscale HTTPS private access. Use when configuring this PWA, diagnosing remote Codex authentication, adding the Windows console, validating Tailscale Serve, or handing the deployment to another agent.
---

# Codex Remote Installer

Deploy this project as a private, loopback-only Windows service. Read [installation.md](references/installation.md) before changing configuration or network state.

## Workflow

1. Inspect the project root, `.env.example`, `AGENTS.md`, and the existing service status. Do not print real `.env` values, session contents, access passwords, or provider keys.
2. Verify prerequisites: Node.js 20+, Codex CLI, Tailscale, and a working `WORKSPACE_ROOT`.
3. Configure `.env` with a unique `REMOTE_PASSWORD`, fixed workspace, and a separate remote `CODEX_HOME`. Preserve the custom provider in that home directory's `config.toml`; `OPENAI_API_KEY` may contain a compatible-provider credential.
4. Run `npm run auth:api` only after the remote `CODEX_HOME` and provider configuration are correct. The script initializes CLI authentication without echoing the key.
5. Build the desktop console with `scripts/build-codex-remote-client.ps1`, then use `Start-CodexRemotePWA.cmd`. Keep PWA startup manual: do not create a scheduled task, Run key, or startup-folder entry.
6. Configure Tailscale Serve for the loopback port. With HTTPS, set `COOKIE_SECURE=1`, `TRUST_PROXY=1`, and the matching `PUBLIC_ORIGIN`.
7. Run `npm test`, confirm `/api/me` is reachable locally, then verify phone login and one approved task through the Tailscale HTTPS URL.

## Recovery rules

- For a missing-bearer `401`, check the remote `CODEX_HOME/config.toml` and local provider key first. Do not change the provider to OpenAI or switch the Desktop App account.
- For a hidden or missing Windows console, rebuild and run `CodexRemoteConsole.exe`; do not restore the old hidden PowerShell/mutex launcher.
- For Desktop history continuity, keep session JSONL append-only and run the integration test before modifying mirroring logic.
- Do not bind the server to a public interface, expose the port through a router, stop Tailscale without user confirmation, or delete runtime data to resolve an issue.
