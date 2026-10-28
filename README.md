# zunivo-mcp

An MCP server that gives the agent a USDC wallet on Arc. Works with any MCP client (Claude Desktop, Claude Code, Cursor, and so on).

Tools: `zunivo_resolve_agent` (name to on-chain card), `zunivo_list_agents` (the directory), `zunivo_paid_fetch` (call a paid API, pay the 402 within budget), `zunivo_create_payment_link`, `zunivo_check_order`, `zunivo_spend_status`.

The private key lives in env and no tool returns it. Each call is capped (`ZUNIVO_MAX_PER_CALL`, default 1 USDC) under a daily cap (`ZUNIVO_DAILY_CAP`, default 5 USDC). Set `ZUNIVO_SPEND_FILE` so the budget survives restarts; do that before using real money. Anything a paid endpoint returns is untrusted input to the model, and the daily cap is what limits the damage if one tries to talk the agent into more calls, so keep it small. When paying a `.agent` name the recipient is pinned to the address the name resolves to.

## Setup (Claude Desktop)

```json
{
  "mcpServers": {
    "zunivo": {
      "command": "npx",
      "args": ["-y", "zunivo-mcp"],
      "env": {
        "AGENT_PK": "0x<agent wallet private key>",
        "ZUNIVO_NETWORK": "arc",
        "ZUNIVO_DAILY_CAP": "5",
        "ZUNIVO_MAX_PER_CALL": "1"
      }
    }
  }
}
```

`ZUNIVO_NETWORK` is `arc` (mainnet, real USDC, the default since 0.2.0) or
`arc-testnet` (free sandbox). The SDK already knows the registry contracts for
both, so `ZUNIVO_RECORDS_ADDRESS` / `ZUNIVO_NAMES_ADDRESS` are only overrides.
Fund the wallet with USDC on Arc mainnet (bridge via CCTP), or with test USDC at
https://faucet.circle.com when on `arc-testnet`. `zunivo_spend_status` reports
which network and API the server is on.

## Example session

> **You:** find me a crypto index feed and get the latest value
>
> **Agent:** *lists agents → finds `data.agent` → paid_fetch `/v1/index/crypto`
> → pays 0.05 USDC → returns the data + ArcScan receipt*

Part of the [Zunivo](https://zunivo.io) network — the payment layer for AI
agents on Arc.
