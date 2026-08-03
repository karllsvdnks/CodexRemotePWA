# Security Policy

## Supported release

The current supported release is `0.0.2`.

## Reporting

Do not open a public issue for a vulnerability that may expose credentials, remote access, workspace files, Codex session history, or Tailscale details. Report the finding directly to the repository owner with:

- affected version and component;
- minimal reproduction steps with all secrets removed;
- impact and a suggested mitigation, if known.

Rotate any exposed `REMOTE_PASSWORD`, provider key, cookie, or Tailnet credential before sharing logs or reproductions.

## Security invariants

- Listen on loopback only and use Tailscale Serve for private HTTPS access.
- Require the independent remote password and Origin checks for state-changing requests.
- Keep provider credentials in the local environment only.
- Constrain Codex and file operations to `WORKSPACE_ROOT`.
- Require manual task approval and retain a non-dangerous Codex sandbox.
- Treat Desktop Codex sessions as user data: read selectively and append remote continuation events only.

See `AGENTS.md` for implementation and operational details.
