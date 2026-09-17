#!/usr/bin/env node
/**
 * zunivo-mcp over stdio.
 *
 * Configure via env (all payments bounded by the spend tracker):
 *   AGENT_PK                 the agent wallet's private key (never exposed to the model)
 *   ZUNIVO_DAILY_CAP         hard daily USDC budget            (default "5")
 *   ZUNIVO_MAX_PER_CALL      per-call USDC ceiling             (default "1")
 *   ZUNIVO_NETWORK           "arc" (MAINNET, real USDC — default) or "arc-testnet"
 *   ZUNIVO_API               Zunivo API   (default follows ZUNIVO_NETWORK: api.zunivo.io / testnet-api.zunivo.io)
 *   ZUNIVO_KEY               API key for creating payment links (optional)
 *   ZUNIVO_RECORDS_ADDRESS   ZunivoAgentRecords contract on Arc
 *   ZUNIVO_NAMES_ADDRESS     ZunivoNames contract              (default set in SDK)
 *   ZUNIVO_RPC_URL           Arc RPC override                  (default per network)
 *
 * Claude Desktop / claude_desktop_config.json:
 *   { "mcpServers": { "zunivo": { "command": "npx", "args": ["-y", "zunivo-mcp"],
 *       "env": { "AGENT_PK": "0x…", "ZUNIVO_RECORDS_ADDRESS": "0x…" } } } }
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { buildServer } from "./server.mjs";

const server = buildServer();
await server.connect(new StdioServerTransport());
console.error(`[zunivo-mcp] ready — ${process.env.ZUNIVO_NETWORK ?? "arc"} — agent wallet ` + (process.env.AGENT_PK ? "configured" : "NOT configured (read-only tools only)"));
