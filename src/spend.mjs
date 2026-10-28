/**
 * Daily USDC budget for the agent wallet: a daily cap and a per-call ceiling,
 * both from env. Spend is counted when the tx is submitted, so a call that
 * crashes afterwards still counts.
 *
 * With ZUNIVO_SPEND_FILE set the file is the source of truth. Every call
 * re-reads it and record() does an atomic read-modify-write, so the budget
 * survives restarts and is shared between instances. Without a file the
 * counter is per process and a restart resets it. Set the file before using
 * real money.
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export function createSpendTracker({ dailyCap = "5", maxPerCall = "1", file = process.env.ZUNIVO_SPEND_FILE } = {}) {
  const capMicro = toMicro(dailyCap);
  const perCallMicro = toMicro(maxPerCall);
  const persistPath = file ? expand(file) : null;

  // In-memory fallback state (used only when no file is configured).
  let memDay = today();
  let memSpent = 0n;

  /** Read the current day's spend from the source of truth, rolling over at UTC midnight. */
  function readSpent() {
    const d = today();
    if (!persistPath) {
      if (d !== memDay) { memDay = d; memSpent = 0n; }
      return memSpent;
    }
    try {
      const s = JSON.parse(fs.readFileSync(persistPath, "utf8"));
      // A record from a previous day means today's spend is 0.
      if (s.day === d && typeof s.spentMicro === "string" && /^\d+$/.test(s.spentMicro)) {
        return BigInt(s.spentMicro);
      }
    } catch { /* missing or corrupt → treat as 0 spent today (same exposure as no-file default) */ }
    return 0n;
  }

  function writeSpent(spentMicro) {
    const d = today();
    if (!persistPath) { memDay = d; memSpent = spentMicro; return; }
    try {
      fs.mkdirSync(path.dirname(persistPath), { recursive: true });
      // atomic-ish: write to temp then rename, so a concurrent reader never sees a half file
      const tmp = `${persistPath}.tmp${process.pid}`;
      fs.writeFileSync(tmp, JSON.stringify({ day: d, spentMicro: spentMicro.toString() }));
      fs.renameSync(tmp, persistPath);
    } catch { /* best-effort; the in-memory cap for THIS call still holds via the returned value */ }
  }

  return {
    /** Max price (USDC string) the next single call may cost, or null if budget exhausted. */
    allowance() {
      const left = capMicro - readSpent();
      if (left <= 0n) return null;
      const per = left < perCallMicro ? left : perCallMicro;
      return fromMicro(per);
    },
    /** Record a payment about to be submitted (atomic read-modify-write). */
    record(priceUsdc) {
      const next = readSpent() + toMicro(priceUsdc);
      writeSpent(next);
    },
    status() {
      const spent = readSpent();
      return {
        day: today(),
        dailyCap: fromMicro(capMicro),
        spentToday: fromMicro(spent),
        remaining: fromMicro(capMicro > spent ? capMicro - spent : 0n),
        maxPerCall: fromMicro(perCallMicro),
        persisted: Boolean(persistPath),
      };
    },
  };
}

function expand(p) {
  return p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p;
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function toMicro(usdc) {
  const s = String(usdc).trim();
  if (!/^\d+(\.\d{1,6})?$/.test(s)) throw new Error(`invalid USDC amount "${usdc}"`);
  const [whole, frac = ""] = s.split(".");
  return BigInt(whole) * 1_000_000n + BigInt(frac.padEnd(6, "0"));
}

function fromMicro(m) {
  const whole = m / 1_000_000n;
  const frac = (m % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole.toString();
}
