# Contributing

## Scope

Keep this a private, self-hosted Windows and Tailscale application. Preserve the loopback-only server, approval gate, workspace confinement, Desktop JSONL append-only behavior, and manual PWA startup policy described in `AGENTS.md`.

## Local workflow

1. Create a focused branch from `main` using `feature/`, `fix/`, `docs/`, or `chore/`.
2. Do not stage `.env`, `data/`, `node_modules/`, Desktop Codex sessions, or runtime logs.
3. Make the smallest compatible change. Preserve the native Node HTTP implementation and avoid dependencies unless they remove substantial complexity.
4. Run `npm test` before requesting review. Rebuild `CodexRemoteConsole.exe` when `client/CodexRemoteConsole.cs` changes.
5. Update the user-facing documentation, `AGENTS.md`, or `CHANGELOG.md` when behavior or operations change.

## Required review checks

- Security: retain authenticated API access, Origin checks, workspace confinement, upload limits, and protected file filtering.
- Desktop continuity: do not rewrite Desktop session JSONL; only append deduplicated remote message records.
- PWA updates: increment the version in `public/sw.js` and the cache-busting query values in `public/index.html` when changing the application shell.
- Windows operations: do not add automatic startup tasks or change the Tailscale service startup mode.
- Secrets: never include credentials, cookies, Tailnet data, or personal session transcripts in a commit, issue, pull request, or log.

## Commit and release conventions

Use concise conventional commit subjects, for example `feat: add file preview`, `fix: preserve desktop mirror events`, or `docs: clarify manual startup`.

`package.json` is the source of the application version. Update `CHANGELOG.md`, create an annotated `v<version>` tag, and follow `docs/RELEASE.md` for a release.
