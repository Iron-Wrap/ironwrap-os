# Newo MCP

Allowlisted MCP access to IronWrap's bounded Newo Worker routes. This server never receives a
Newo API key and never exposes a raw provider proxy. The Worker owns token exchange, API timeouts,
configuration gates, D1 control evidence, and provider calls.

Reads are individually typed. Provider mutations follow three explicit tools:

1. `dry_run_newo_control_action` stores and signs the exact operation and arguments.
2. `request_newo_control_approval` records the human identity/reason and returns a signed approval receipt.
3. `request_newo_control_action` consumes both receipts once and executes the bound provider operation.

`NEWO_MCP_WRITE_ENABLED=true` is required for the two approval/write tools. Worker-side
`NEWO_CONTROL_WRITE_ENABLED=true` is independently required for provider execution, and customer
send operations additionally require Worker-side `NEWO_OUTBOUND_ENABLED=true`.

## Runtime

```bash
IRONWRAP_BUS_BASE_URL=https://... \
IRONWRAP_ADMIN_TOKEN=... \
MCP_ALLOWED_TOOLS=get_newo_health,list_newo_sessions \
NEWO_MCP_WRITE_ENABLED=false \
node src/server.mjs
```

The server registers only the tools named in `MCP_ALLOWED_TOOLS` and refuses to start without the
list or with a name it does not have. There is no default grant.
