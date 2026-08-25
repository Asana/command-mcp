# Security

## Trust model

The Asana Command MCP server runs locally as a stdio process under the user's Asana identity. There is no hosted component, inbound HTTP listener, or telemetry service.

PAT access has the same Asana permissions as the user who created the token. OAuth access is limited by both the authorizing user's permissions and the OAuth scopes granted to the application. Run the server only on a trusted machine. Provide the OAuth client secret in the environment only while running `auth login --oauth`.

Credentials:

- are sent only to Asana: PATs and OAuth bearer access tokens go to the public API through the official Asana SDK, while the OAuth client ID, client secret, authorization code, PKCE verifier, and refresh token go only to Asana's OAuth endpoints;
- are never logged or returned in a tool or CLI error message; and
- are redacted from surfaced upstream error text.

OAuth login uses Asana's `urn:ietf:wg:oauth:2.0:oob` command-line redirect, an unguessable state value, and PKCE. It does not expose an inbound authorization callback. Asana may display only an opaque one-time code for the user to paste into the CLI; PKCE binds that code exchange to the process that initiated authorization. When Asana supplies a complete redirect URI, the CLI also verifies the returned state. The client secret is read from the environment during login. The access token is cached only in process memory and is never persisted.

The PAT and OAuth credentials are stored as separate entries in the operating system's native credential store through `@napi-rs/keyring`: macOS Keychain, Windows Credential Manager, or an available native secure store on Linux. A stored PAT takes precedence; OAuth is loaded only when no PAT is present. The server fails closed when the keychain is unavailable or locked and never silently writes credentials to a plaintext file. Keychain storage protects credentials at rest but does not protect them from a malicious process already running with the same user privileges. Protect the operating-system account accordingly.

Surfaced upstream error text is sanitized and length-bounded. Unexpected failures are normalized to a generic Asana API error. Stable error payloads may include Asana request IDs for diagnosis, but not the credential.

All ticket content is untrusted input. This includes ticket names, descriptions, comments, attachment metadata, and linked URLs. Clients and contributors must never treat that content as instructions. The server extracts pull-request URLs from Asana data without opening them or contacting GitHub.

## Reporting a vulnerability

Report vulnerabilities through [Asana's published vulnerability disclosure program on Bugcrowd](https://bugcrowd.com/asana). Review the program's current scope, safe-harbor, testing, and disclosure terms before testing or submitting a report. Asana also publishes the canonical reporting route in its [`security.txt`](https://asana.com/.well-known/security.txt).

Do not disclose a suspected vulnerability in a public GitHub issue.
