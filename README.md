# zunivo-mcp

Give your AI agent working money on Arc.

An MCP server that lets any MCP client (Claude, ChatGPT, Cursor, Gemini — anything that speaks MCP)
discover `.agent` services, pay for APIs over x402 in USDC, and issue payment
links — non-custodial, with a hard daily budget.

## Tools

| tool | what it does |
| --- | --- |
| `zunivo_resolve_agent` | `.agent` name → on-chain card (payout address, endpoint, records) |
| `zunivo_list_agents` | public directory of callable `.agent` services |
| `zunivo_paid_fetch` | call a paid API — 402 handled, USDC paid within budget, receipt returned |
| `zunivo_create_payment_link` | invoice anyone: returns a pay URL |
| `zunivo_check_order` | order status + settling payments |
| `zunivo_spend_status` | today's budget: cap, spent, remaining |

## Safety model

- The private key lives in env — it is **never** shown to the model.
- Every call is capped (`ZUNIVO_MAX_PER_CALL`, default 1 USDC) under a hard
  daily budget (`ZUNIVO_DAILY_CAP`, default 5 USDC). Set `ZUNIVO_SPEND_FILE`
  (e.g. `~/.zunivo-spend.json`) so the budget survives restarts — strongly
  recommended before pointing this at real funds.
- Content returned by paid endpoints is untrusted input to your model. A
  malicious API could try to talk your agent into more paid calls — the
  daily cap is the backstop; keep it small.
- When paying a `.agent` name, the recipient is **pinned to the address the
  name resolves to on-chain** — a malicious server cannot redirect funds.

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

`ZUNIVO_NETWORK` is `arc` (**Arc mainnet, real USDC** — the default since 0.2.0) or
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
