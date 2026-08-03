# Release Process

Use this process for every published version. Do not publish a tag containing `.env`, `data/`, logs, Desktop session files, or credentials.

## Distribution Profile

The Windows ZIP is a consumer package, not a source or agent handoff. `npm run package:release` enforces this profile:

- The root contains the runtime, `CodexRemoteConsole.exe`, `CodexRemoteSetup.exe`, `Start-CodexRemotePWA.cmd`, `README.md`, `教程.md`, public assets, the approved Windows x64 Tailscale installer, and only the scripts required to run or configure the service.
- The only distributed configuration is a safe default `.env`, generated from `scripts/release-default.env`. It contains no provider key, cookie, session, user path, or local history. The placeholder password must be replaced before the server can start.
- `README.md` and `教程.md` are the only distributed Markdown documents. The console and PowerShell fallback both open `教程.md` for Help.
- Exclude `AGENTS.md`, agent skills, source-only client files, release tooling, changelogs, contribution and security documents, local `.env`, `data/`, logs, `node_modules`, and `.git`.

When this profile changes, update `scripts/package-release.ps1`, these release notes, and the two distributed documents together, then rebuild the EXE if the console behavior changed.

## Continuation Record

Current validated baseline: `0.0.3` on 2026-08-03.

- The project is independently rooted; release documentation must not refer to its former parent directory.
- The package is deliberately an end-user runtime archive. It contains no agent handoff files, development-only client source, release tooling, test files, repository metadata, local data, logs, or installed dependencies.
- `.env.example` is intentionally absent. `scripts/release-default.env` is copied into the archive as `.env`, with safe defaults and a password placeholder that prevents use until the recipient changes it.
- Help in both desktop clients targets the packaged `教程.md`. The only Markdown entries allowed in the archive are `README.md` and `教程.md`.
- After any change to a distributed runtime file or either user document, run `npm test` in the source repository, rebuild `CodexRemoteConsole.exe` when its source changed, then run `npm run package:release`. Verify the new archive by inspecting its entries and confirming that it contains no `test/` directory or `test` package script.
- The bundled Tailscale installer is `installers\tailscale-setup-1.98.10.exe`, downloaded from `https://pkgs.tailscale.com/stable/tailscale-setup-1.98.10.exe`. Its approved SHA-256 is `3AC2CEABAF5FFF67CECAA02D597ED1FB419FC890F33AC6C53A6C8339B1E35952`; when updating it, verify Tailscale's Authenticode signature, update this record and `scripts/package-release.ps1`, then rebuild and validate the ZIP.
- `scripts/package-release.ps1` has an exact release-entry whitelist. Add a file only after documenting its end-user runtime role; otherwise the package build must reject it.
- `CodexRemoteSetup.exe` owns first-run configuration. It generates a replacement password when needed, writes only the project `.env`, leaves an existing password or API Key untouched when the corresponding input is empty, and offers Tailscale Serve only through an explicit user checkbox.

This continuation record is intentionally kept outside the archive in `docs/RELEASE.md`; it informs maintainers without introducing agent-related material into the user distribution.

## Prepare

1. Confirm `main` is clean and review `git status --short`.
2. Set the version in `package.json` and add dated release notes to `CHANGELOG.md`.
3. If the Windows client changed, run `scripts\\build-codex-remote-client.ps1` and verify `CodexRemoteConsole.exe` opens through `Start-CodexRemotePWA.cmd`.
4. Run `npm test`.
5. Review staged files with `git diff --cached --name-only` and confirm local `.env` and `data/` are absent. The release ZIP may contain only the safe defaults generated from `scripts/release-default.env`.

## Tag

```powershell
git add .
git commit -m "chore: release v<version>"
git tag -a v<version> -m "Release <version>"
```

Tag only the commit intended for publication. Do not rewrite a tag after it has been pushed or used to create a GitHub release.

## Publish

1. Push `main` and the annotated tag to the selected GitHub repository.
2. Create the GitHub release from the matching tag.
3. Attach `CodexRemoteConsole.exe` only if it was rebuilt from the committed `client/CodexRemoteConsole.cs` source in the same release.
4. Copy the release notes from `CHANGELOG.md`; do not include deployment URLs, credentials, or user conversation data.

## Verify

- Confirm GitHub Actions passes for the tagged commit.
- Clone into a separate disposable directory and run `npm test`.
- Confirm the release `.env` has only safe defaults and that `README.md` and `教程.md` are present.
- Keep the live local deployment running independently of the repository clone until the new release has been verified.
