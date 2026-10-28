# Security policy

MeshMind connects Agents to physical devices, so reports about authentication, tenant isolation, gateway identity, device authorization, secret handling, or release integrity are treated as security-sensitive.

Do not open a public issue for a suspected vulnerability. When GitHub private vulnerability reporting is enabled, use the repository's **Security → Report a vulnerability** flow. Until then, contact the repository owner through an existing private channel. Include the affected version, attack path, impact, and a minimal reproduction without real credentials or personal device data.

Supported security fixes target the current `main` branch and the currently deployed SaaS version. Preview builds and historical prototypes under `cloudflare/`, `master/`, `agent/`, and `infra/` are not production deployment targets, but reports showing a concrete path into current users or infrastructure are still relevant.

Never include Google OAuth secrets, MeshMind bearer credentials, enrollment files, gateway identities, printer access codes, Home Assistant tokens, or ADB device data in a report.
