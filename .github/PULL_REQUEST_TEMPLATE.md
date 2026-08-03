## Summary

<!-- Describe the user-visible behavior and operational impact. -->

## Verification

- [ ] `npm test`
- [ ] Documentation updated when behavior or operations changed
- [ ] PWA cache version updated when changing the application shell
- [ ] Windows client rebuilt and checked when C# client source changed

## Security and Operations

- [ ] No `.env`, runtime data, session content, credentials, or deployment URL was included
- [ ] No automatic PWA startup task or Tailscale service startup setting was added or changed
- [ ] Workspace confinement, approval flow, and Desktop JSONL append-only behavior are preserved
