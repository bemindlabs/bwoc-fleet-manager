# Security Policy

## Supported versions

Only the latest release on `main` receives security fixes.

## Reporting a vulnerability

**Please do not open a public issue for security problems.**

Report privately using either:

- GitHub's [private vulnerability reporting](https://github.com/bemindlabs/bwoc-fleet-manager/security/advisories/new), or
- email **info@bemind.tech** with the subject `[security] bwoc-fleet-manager`.

Include what you found, how to reproduce it, and the impact you expect. You can expect an
acknowledgement within a few days; we will keep you updated and credit you in the fix unless you
prefer otherwise.

## Scope and threat model

Fleet Manager can write to agent inboxes and change agent state, and its API has **no
authentication**. Its security boundary is network reachability:

- The API and the host sidecar bind to loopback by default. Binding them to `0.0.0.0` or putting
  them behind a public reverse proxy is **unsupported and unsafe**.
- Write requests require the `x-fleet-manager` header as a CSRF guard; this is not authentication.
- CLI calls use `execFile` with argv arrays, and names are resolved against the discovered fleet.

Reports about exposure caused by deliberately removing these protections are out of scope.
Bypasses of the protections above, injection into CLI calls, or path traversal in the file editor
are in scope.
