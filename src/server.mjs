/**
 * zunivo-mcp: MCP server with a USDC wallet on Arc for the agent.
 *
 * Tools:
 *   zunivo_resolve_agent      name → on-chain agent card (address, endpoint, records)
 *   zunivo_list_agents        the public .agent service directory
 *   zunivo_paid_fetch         call a paid API; 402 handled, USDC paid, receipt returned
 *   zunivo_create_payment_link  invoice someone: returns a pay URL
 *   zunivo_check_order        order status (unpaid/paid) + payments
 *   zunivo_spend_status       today's budget: cap, spent, remaining
 *
 * The private key stays in env and is not returned by any tool. Payments are
 * capped per call and per day. paid_fetch pins the recipient to the address the
 * .agent name resolves to.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createSpendTracker } from "./spend.mjs";

const TRUNCATE_BODY = 20_000;

export function buildServer(overrides = {}) {
  const env = { ...process.env, ...(overrides.env ?? {}) };
  // Network: "arc" (Arc MAINNET, default since 0.2.0) or "arc-testnet". Picks the SDK
  // chain/router/registry AND the matching Zunivo API host.
  const network = env.ZUNIVO_NETWORK ?? "arc";
  if (network !== "arc" && network !== "arc-testnet") throw new Error(`ZUNIVO_NETWORK must be "arc" or "arc-testnet" (got "${network}")`);
  const api = (env.ZUNIVO_API ?? (network === "arc" ? "https://api.zunivo.io" : "https://testnet-api.zunivo.io")).replace(/\/$/, "");
  const fetchImpl = overrides.fetchImpl ?? fetch;
  const spend = overrides.spend ?? createSpendTracker({
    dailyCap: env.ZUNIVO_DAILY_CAP ?? "5",
    maxPerCall: env.ZUNIVO_MAX_PER_CALL ?? "1",
  });

  // sdk fns are injectable so tests run without a chain
  const sdk = overrides.sdk ?? null; // lazily imported on first use otherwise
  async function getSdk() {
    if (sdk) return sdk;
    return import("zunivo-x402-arc");
  }

  const server = new McpServer({ name: "zunivo", version: "0.1.0" });

  const text = (obj) => ({ content: [{ type: "text", text: typeof obj === "string" ? obj : JSON.stringify(obj, null, 2) }] });
  const fail = (msg) => ({ content: [{ type: "text", text: `ERROR: ${msg}` }], isError: true });

  server.tool(
    "zunivo_resolve_agent",
    "Resolve a .agent name to its on-chain agent card: payout address, service endpoint, x402 manifest, description. Accepts 'data.agent', '@data' or 'data'.",
    { name: z.string().describe(".agent name to resolve") },
    async ({ name }) => {
      try {
        const { discoverAgent } = await getSdk();
        const card = await discoverAgent(name, {
          network,
          recordsAddress: env.ZUNIVO_RECORDS_ADDRESS,
          namesAddress: env.ZUNIVO_NAMES_ADDRESS,
          rpcUrl: env.ZUNIVO_RPC_URL,
        });
        return text(card);
      } catch (e) { return fail(e.message); }
    }
  );

  server.tool(
    "zunivo_list_agents",
    "List every .agent name that has published a callable service (the public agent directory on Arc).",
    {},
    async () => {
      try {
        const r = await fetchImpl(`${api}/api/agents`);
        if (!r.ok) return fail(`directory returned ${r.status}`);
        return text(await r.json());
      } catch (e) { return fail(e.message); }
    }
  );

  server.tool(
    "zunivo_paid_fetch",
    "Call a paid HTTP API. If the server responds 402, pay the quoted USDC price from the agent wallet (within budget) and retry automatically. Target is either a full url, or an agent name + path. Returns status, body and the payment receipt if one was made.",
    {
      url: z.string().optional().describe("full URL of the paid endpoint"),
      agent: z.string().optional().describe(".agent name — endpoint is discovered on-chain"),
      path: z.string().optional().describe("path appended to the agent's endpoint, e.g. /v1/data"),
      method: z.enum(["GET", "POST"]).default("GET"),
      body: z.string().optional().describe("request body for POST (JSON string)"),
    },
    async ({ url, agent, path, method, body }) => {
      try {
        if (!env.AGENT_PK) return fail("AGENT_PK not configured — the agent has no wallet");
        const allowance = spend.allowance();
        if (allowance === null) return fail(`daily spend cap reached (${spend.status().dailyCap} USDC) — try again tomorrow or raise ZUNIVO_DAILY_CAP`);

        const { createX402Fetch, discoverAgent } = await getSdk();
        let target = url;
        let expectRecipient;
        if (!target) {
          if (!agent) return fail("provide either url or agent");
          const card = await discoverAgent(agent, {
            network,
            recordsAddress: env.ZUNIVO_RECORDS_ADDRESS,
            namesAddress: env.ZUNIVO_NAMES_ADDRESS,
            rpcUrl: env.ZUNIVO_RPC_URL,
          });
          if (!card.endpoint) return fail(`${card.name} has not published a service endpoint`);
          target = new URL(path ?? "", card.endpoint).toString();
          expectRecipient = card.address; // pay only whoever the name resolves to
        }

        const events = [];
        const paidFetch = createX402Fetch({
          privateKey: env.AGENT_PK,
          network,
          maxPrice: allowance,
          expectRecipient,
          onEvent: (e) => {
            events.push(e);
            if (e.type === "paying" && e.price) spend.record(e.price);
          },
        });

        const res = await paidFetch(target, {
          method,
          headers: body ? { "content-type": "application/json" } : undefined,
          body,
        });
        const bodyText = (await res.text()).slice(0, TRUNCATE_BODY);
        const paid = events.find((e) => e.type === "paid");
        const quote = events.find((e) => e.type === "quote");
        return text({
          status: res.status,
          paid: paid ? { txHash: paid.txHash, price: quote?.price, to: quote?.payTo } : null,
          budget: spend.status(),
          body: bodyText,
        });
      } catch (e) { return fail(e.message); }
    }
  );

  server.tool(
    "zunivo_create_payment_link",
    "Create a Zunivo payment link (invoice): anyone opening it can pay the given USDC amount to a .agent name or 0x address. Returns the pay URL and order id.",
    {
      to: z.string().describe("recipient — .agent name or 0x address"),
      amount: z.string().describe("USDC amount, e.g. '25' or '0.50'"),
      memo: z.string().optional(),
    },
    async ({ to, amount, memo }) => {
      try {
        if (!env.ZUNIVO_KEY) return fail("ZUNIVO_KEY not configured — payment links need an API key");
        const r = await fetchImpl(`${api}/v1/orders`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-api-key": env.ZUNIVO_KEY },
          body: JSON.stringify({ to, amount, memo }),
        });
        const data = await r.json();
        if (!r.ok) return fail(data.error ?? `orders API returned ${r.status}`);
        return text(data);
      } catch (e) { return fail(e.message); }
    }
  );

  server.tool(
    "zunivo_check_order",
    "Check a payment link / order: status (unpaid or paid) and the on-chain payments that settled it.",
    { orderId: z.string().describe("order id returned by zunivo_create_payment_link") },
    async ({ orderId }) => {
      try {
        const r = await fetchImpl(`${api}/api/orders/${encodeURIComponent(orderId)}`);
        if (!r.ok) return fail(`orders API returned ${r.status}`);
        return text(await r.json());
      } catch (e) { return fail(e.message); }
    }
  );

  server.tool(
    "zunivo_spend_status",
    "Show today's spending budget for the agent wallet: daily cap, spent so far, remaining, per-call ceiling.",
    {},
    async () => text({ network, api, ...spend.status() })
  );

  return server;
}
