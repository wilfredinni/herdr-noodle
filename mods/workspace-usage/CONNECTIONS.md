# AI connections

The stable connection registry is `connections.js`, independent of the status bar.
Each connection has an ID, driver and CLI auth reference. `readConnection` reads usage;
Commit generation separately discovers authenticated Codex/OpenCode models through those
same installed CLI sign-ins and revalidates its selected provider and model before sending a diff. A usage reading does not grant generation access.
OpenCode Go quotas use the native read-only `/api/experimental/usage/limits` endpoint
for the focused project location. An existing Go API key alone can return `data: null`;
the CLI must have an OpenCode Console workspace sign-in with account metadata.
The UI explicitly reports this, rather than showing a fake 0%.

No credentials are copied into Herdr. Re-authenticate using the provider's CLI.

`collect.py` queries existing CLIs in neutral temporary folders, without model prompts.
Codex uses the documented app-server account and quota APIs. Claude uses the internal
`get_usage` control interface, which can change between CLI versions. OpenCode reports
local estimates split by its current configured authentication methods; historical account
switches can make that split inaccurate. Those numbers are not invoices.

Kiro usage comes from `kiro-cli chat --no-interactive /usage --v2`, tested with the
IAM Identity Center KIRO POWER report. The V2 flag keeps `/usage` in the CLI command
handler. Monthly usage uses the reported credits and reset date; unsupported reports
fail without inventing zeroes. This text interface can change, and Kiro may save an
empty session per refresh. Authentication stays managed by Kiro.

Usage is fetched every five minutes, separately for the active machine. Failed reads retain
clearly dated last-good values; removed or signed-out connections clear them. Past quota
reset times show a pending refresh instead of 0%.

Reference: https://github.com/nozikov/herdr-usage-limits (MIT). Its separation of CLI reads,
provider normalization and presentation informed this implementation, particularly Claude's
`get_usage` approach, credited there to https://github.com/jmalicki/herdr-mod-ai-usage.

The status bar and details panel render quota windows only. Local spending and account
classification remain connection metadata for other consumers, and are not shown here.
