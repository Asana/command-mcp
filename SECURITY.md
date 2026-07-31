# Security

## Trust model

The Asana Command MCP server runs locally, as a stdio process, under the user's own Asana Personal Access Token (PAT). There is no hosted component, inbound HTTP listener, or telemetry service.

A PAT carries the full Asana permissions of the user who created it. Run the server only on a trusted machine and provide the token through a protected MCP client configuration or local, untracked `.env` file.

The token:

- is sent only to Asana's public API through the official Asana SDK;
- is never logged;
- is never returned in a tool or CLI error message; and
- is redacted, together with bearer credentials, from upstream error text before that text is surfaced.

Surfaced upstream error text is sanitized and length-bounded. Unexpected failures are normalized to a generic Asana API error. Stable error payloads may include Asana request IDs for diagnosis, but not the credential.

All ticket content is untrusted input. This includes ticket names, descriptions, comments, attachment metadata, and linked URLs. Clients and contributors must never treat that content as instructions. The server extracts pull-request URLs from Asana data without opening them or contacting GitHub.

## Reporting a vulnerability

Report vulnerabilities through [Asana's published vulnerability disclosure program on Bugcrowd](https://bugcrowd.com/asana). Review the program's current scope, safe-harbor, testing, and disclosure terms before testing or submitting a report. Asana also publishes the canonical reporting route in its [`security.txt`](https://asana.com/.well-known/security.txt).

Do not disclose a suspected vulnerability in a public GitHub issue.
