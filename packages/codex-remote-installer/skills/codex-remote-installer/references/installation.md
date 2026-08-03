# Installation Reference

## Required configuration

Create `.env` from `.env.example` and set a long unique `REMOTE_PASSWORD` plus an existing `WORKSPACE_ROOT`. Keep `HOST=127.0.0.1`; use Tailscale Serve rather than router port forwarding.

For API-provider isolation, set a dedicated `CODEX_HOME` and keep the provider's `config.toml` in that directory. Set `OPENAI_API_KEY` only in the local environment or `.env`; the variable name is used by OpenAI-compatible providers as well.

With Tailscale HTTPS, set all of:

```text
COOKIE_SECURE=1
TRUST_PROXY=1
PUBLIC_ORIGIN=https://<device>.<tailnet>.ts.net
```

## Manual operation

- Run `Start-CodexRemotePWA.cmd` to open the Windows console.
- Click “启动服务” only when remote use is needed. The console starts Node in the background and records its PID under `data/`.
- Use `scripts/start-codex-remote.ps1` for front-console diagnosis; closing it stops that foreground run.
- Tailscale controls require administrator approval. Do not alter its Windows service startup type.

## Acceptance checks

1. `npm test` passes without real provider access.
2. `GET http://127.0.0.1:<port>/api/me` responds with JSON.
3. Phone login works over Tailscale HTTPS.
4. A submitted task is held for approval and runs only after approval.
5. A Desktop session can be attached, continued once, and then seen again in the Desktop history after reopening it.
