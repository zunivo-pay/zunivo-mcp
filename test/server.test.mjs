import assert from "node:assert";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../src/server.mjs";
import { createSpendTracker } from "../src/spend.mjs";

// ---------- spend tracker ----------
{
  const t = createSpendTracker({ dailyCap: "1", maxPerCall: "0.4" });
  assert.equal(t.allowance(), "0.4");
  t.record("0.4");
  assert.equal(t.allowance(), "0.4");
  t.record("0.4");
  assert.equal(t.allowance(), "0.2"); // remaining < perCall → clipped
  t.record("0.2");
  assert.equal(t.allowance(), null);  // cap reached
  const s = t.status();
  assert.equal(s.spentToday, "1");
  assert.equal(s.remaining, "0");
  console.log("✓ spend tracker: cap, clipping, exhaustion");
}

// ---------- mocked deps ----------
const OWNER = "0x6963F518A42DD552ed382D45D6a432b3Bc8D90c8";
const mockSdk = {
  async discoverAgent(name) {
    if (!/data/.test(name)) throw new Error(`discoverAgent: ${name} is not registered`);
    return { name: "data.agent", label: "data", address: OWNER, endpoint: "https://api.data.example", records: { url: "https://api.data.example", description: "index" } };
  },
  createX402Fetch({ maxPrice, expectRecipient, onEvent }) {
    return async (url) => {
      onEvent({ type: "quote", price: "0.05", payTo: "data.agent" });
      onEvent({ type: "paying", price: "0.05", to: "data.agent" });
      onEvent({ type: "paid", txHash: "0xd199beef" });
      return new Response(JSON.stringify({ url, maxPrice, expectRecipient, data: 42 }), { status: 200 });
    };
  },
};
const mockFetch = async (url, init) => {
  if (url.endsWith("/api/agents")) return Response.json({ agents: [{ name: "data.agent", records: { url: "https://api.data.example" } }] });
  if (url.endsWith("/v1/orders")) {
    const b = JSON.parse(init.body);
    if (!init.headers["x-api-key"]) return new Response(JSON.stringify({ error: "no key" }), { status: 401 });
    return new Response(JSON.stringify({ id: "ord_1", payUrl: "https://app.zunivo.io/pay?oid=ord_1", to: b.to, amount: b.amount }), { status: 201 });
  }
  if (url.includes("/api/orders/")) return Response.json({ id: "ord_1", status: "paid" });
  return new Response("not found", { status: 404 });
};

async function connect(envOverrides = {}) {
  const server = buildServer({
    sdk: mockSdk,
    fetchImpl: mockFetch,
    env: { AGENT_PK: "0x" + "ab".repeat(32), ZUNIVO_KEY: "zk_test_x", ZUNIVO_RECORDS_ADDRESS: "0x" + "1".repeat(40), ...envOverrides },
  });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([server.connect(st), client.connect(ct)]);
  return client;
}

const client = await connect();

// ---------- tool list ----------
{
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  assert.deepEqual(names, [
    "zunivo_check_order", "zunivo_create_payment_link", "zunivo_list_agents",
    "zunivo_paid_fetch", "zunivo_resolve_agent", "zunivo_spend_status",
  ]);
  console.log("✓ 6 tools registered:", names.join(", "));
}

// ---------- resolve ----------
{
  const r = await client.callTool({ name: "zunivo_resolve_agent", arguments: { name: "data.agent" } });
  const card = JSON.parse(r.content[0].text);
  assert.equal(card.address, OWNER);
  assert.equal(card.endpoint, "https://api.data.example");
  console.log("✓ resolve_agent returns card");

  const bad = await client.callTool({ name: "zunivo_resolve_agent", arguments: { name: "ghost.agent" } });
  assert.ok(bad.isError && /not registered/.test(bad.content[0].text));
  console.log("✓ resolve_agent unknown name errors cleanly");
}

// ---------- directory ----------
{
  const r = await client.callTool({ name: "zunivo_list_agents", arguments: {} });
  assert.ok(JSON.parse(r.content[0].text).agents.length === 1);
  console.log("✓ list_agents hits directory API");
}

// ---------- paid fetch by agent name ----------
{
  const r = await client.callTool({ name: "zunivo_paid_fetch", arguments: { agent: "data.agent", path: "/v1/index" } });
  const out = JSON.parse(r.content[0].text);
  assert.equal(out.status, 200);
  assert.equal(out.paid.txHash, "0xd199beef");
  assert.equal(out.paid.price, "0.05");
  const inner = JSON.parse(out.body);
  assert.equal(inner.url, "https://api.data.example/v1/index");
  assert.equal(inner.expectRecipient, OWNER);            // recipient pinned!
  assert.equal(out.budget.spentToday, "0.05");
  console.log("✓ paid_fetch: discovery + pinned recipient + budget tracked");
}

// ---------- spend cap enforcement ----------
{
  const capped = await connect({ ZUNIVO_DAILY_CAP: "0.04" }); // below the 0.05 quote
  const r = await capped.callTool({ name: "zunivo_paid_fetch", arguments: { url: "https://api.data.example/x" } });
  // allowance is 0.04 → maxPrice passed to client is 0.04; our mock pays anyway,
  // but the REAL client refuses when quote > maxPrice. Here we assert the allowance wiring:
  const out = JSON.parse(r.content[0].text);
  assert.equal(JSON.parse(out.body).maxPrice, "0.04");
  console.log("✓ paid_fetch clips maxPrice to remaining budget");

  const exhausted = await connect({ ZUNIVO_DAILY_CAP: "0" });
  const r2 = await exhausted.callTool({ name: "zunivo_paid_fetch", arguments: { url: "https://x.example" } });
  assert.ok(r2.isError && /daily spend cap/.test(r2.content[0].text));
  console.log("✓ paid_fetch refuses when cap exhausted");
}

// ---------- no wallet ----------
{
  const nowallet = await connect({ AGENT_PK: "" });
  const r = await nowallet.callTool({ name: "zunivo_paid_fetch", arguments: { url: "https://x.example" } });
  assert.ok(r.isError && /no wallet/.test(r.content[0].text));
  console.log("✓ paid_fetch without AGENT_PK errors cleanly");
}

// ---------- payment link + order ----------
{
  const r = await client.callTool({ name: "zunivo_create_payment_link", arguments: { to: "bbb.agent", amount: "25", memo: "invoice #7" } });
  const out = JSON.parse(r.content[0].text);
  assert.equal(out.payUrl, "https://app.zunivo.io/pay?oid=ord_1");
  const r2 = await client.callTool({ name: "zunivo_check_order", arguments: { orderId: "ord_1" } });
  assert.equal(JSON.parse(r2.content[0].text).status, "paid");
  console.log("✓ create_payment_link + check_order");
}

// ---------- spend status ----------
{
  const r = await client.callTool({ name: "zunivo_spend_status", arguments: {} });
  const s = JSON.parse(r.content[0].text);
  assert.ok(s.dailyCap && s.remaining !== undefined);
  console.log("✓ spend_status");
}

console.log("\nALL MCP SERVER TESTS PASS");

// ---------- spend persistence across restarts ----------
{
  const os = await import("node:os");
  const fs = await import("node:fs");
  const f = os.tmpdir() + "/zunivo-spend-test-" + process.pid + ".json";
  try { fs.unlinkSync(f); } catch {}
  const t1 = createSpendTracker({ dailyCap: "1", maxPerCall: "1", file: f });
  t1.record("0.3");
  const t2 = createSpendTracker({ dailyCap: "1", maxPerCall: "1", file: f }); // "restart"
  assert.equal(t2.status().spentToday, "0.3");
  assert.equal(t2.status().persisted, true);
  fs.writeFileSync(f, "corrupt{{{");
  const t3 = createSpendTracker({ dailyCap: "1", maxPerCall: "1", file: f }); // corrupt file
  assert.equal(t3.status().spentToday, "0");
  fs.unlinkSync(f);
  console.log("✓ spend persists across restarts; corrupt file falls back safely");
}

// ---------- CRITICAL: file is source of truth — restart must NOT refill the cap ----------
{
  const os = await import("node:os");
  const fs = await import("node:fs");
  const f = os.tmpdir() + "/zunivo-spend-sot-" + process.pid + ".json";
  try { fs.unlinkSync(f); } catch {}

  // process A spends 0.4
  const A = createSpendTracker({ dailyCap: "1", maxPerCall: "0.5", file: f });
  A.record("0.4");
  assert.equal(A.status().spentToday, "0.4");

  // process B (a "restart" or a second concurrent instance) must SEE the 0.4 immediately
  const B = createSpendTracker({ dailyCap: "1", maxPerCall: "0.5", file: f });
  assert.equal(B.status().spentToday, "0.4", "restart refilled the cap — BUDGET BYPASS");
  assert.equal(B.allowance(), "0.5");

  // B spends 0.5 → total 0.9; A must see it on its NEXT read (no stale cache)
  B.record("0.5");
  assert.equal(A.status().spentToday, "0.9", "process A served a stale in-memory counter");
  assert.equal(A.allowance(), "0.1"); // only 0.1 left, clipped below per-call
  A.record("0.1");
  assert.equal(B.allowance(), null);  // exhausted, seen across both instances
  fs.unlinkSync(f);
  console.log("✓ file-is-source-of-truth: restart/concurrent instances share one budget (no bypass)");
}
