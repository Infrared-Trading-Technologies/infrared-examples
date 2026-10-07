import type { Address } from "viem";
import { fromAtomic } from "./amounts.js";
import type { BotConfig } from "./config.js";
import type { ChainInfo } from "./infrared.js";
import type { ExecutionResult, PendingQuote } from "./trade.js";

export function esc(s: string | number | undefined | null): string {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function short(a: string): string {
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

export function pct(bps: number): string {
  return `${(bps / 100).toFixed(2).replace(/\.?0+$/, "")}%`;
}

export function usd(n: number | null | undefined): string {
  return n === null || n === undefined ? "n/a" : `$${n.toFixed(2)}`;
}

function trim(amount: string, max = 8): string {
  if (!amount.includes(".")) return amount;
  const [i, f] = amount.split(".");
  const cut = (f as string).slice(0, max).replace(/0+$/, "");
  return cut ? `${i}.${cut}` : (i as string);
}

export function feeLine(cfg: BotConfig): string {
  if (cfg.partnerFeeBps === 0) return "This bot charges no fee of its own.";
  return `This bot charges a ${pct(cfg.partnerFeeBps)} fee on the ${cfg.partnerFeeOnOutput ? "output" : "input"} of every swap, paid on-chain to <code>${esc(cfg.partnerRecipient)}</code>.`;
}

export function quoteCard(p: PendingQuote, chain: ChainInfo, cfg: BotConfig): string {
  const lower = (a: string) => a.toLowerCase();
  const sym = (a: string) => esc(p.symbols.get(lower(a)) || short(a));
  const dec = (a: string) => p.decimals.get(lower(a)) as number;
  const q = p.quote;
  const lines: string[] = [`<b>Quote on ${esc(chain.name)}</b>`];
  lines.push("", "<b>You pay</b>");
  for (const i of q.inputs) {
    const human = fromAtomic(i.amount, dec(i.address));
    const price = p.pricesUsd.get(lower(i.address));
    lines.push(`• ${trim(human)} ${sym(i.address)}${price !== undefined ? ` (${usd(Number(human) * price)})` : ""}`);
  }
  lines.push("", "<b>You receive (estimated)</b>");
  for (const o of q.estimated_outputs) {
    const price = p.pricesUsd.get(lower(o.token));
    const exp = fromAtomic(o.expected_amount, dec(o.token));
    lines.push(`• ${trim(exp)} ${sym(o.token)}${price !== undefined ? ` (${usd(Number(exp) * price)})` : ""}  <i>min ${trim(fromAtomic(o.minimum_amount, dec(o.token)))}</i>`);
  }
  const fee = q.fee_config;
  const feeBits: string[] = [];
  if (fee?.partner_fee_bps) feeBits.push(`bot ${pct(fee.partner_fee_bps)}`);
  if (fee?.protocol_fee_bps) feeBits.push(`Infrared ${pct(fee.protocol_fee_bps)}`);
  lines.push("");
  lines.push(`Slippage ${pct(p.slippageBps)} · Price impact ${q.total_price_impact_bps === undefined ? "n/a" : pct(q.total_price_impact_bps)}`);
  lines.push(`Fees: ${feeBits.length ? feeBits.join(" + ") : "none"} (already deducted above)`);
  if (q.costs?.gas_cost_usd !== undefined && q.costs.gas_cost_usd !== null) lines.push(`Network gas ≈ ${usd(q.costs.gas_cost_usd)} (paid by you)`);
  if (q.protocols_used?.length) lines.push(`Route: ${esc(q.protocols_used.join(", "))}`);
  const approvals = (q.approvals ?? []).length;
  if (approvals > 0) lines.push("", `Needs ${approvals} exact-amount approval${approvals > 1 ? "s" : ""} first (one wallet prompt each).`);
  if (cfg.partnerFeeBps > 0 && !fee?.partner_fee_bps) lines.push("", "<i>Note: the API did not apply this bot's partner fee to this quote.</i>");
  return lines.join("\n");
}

export function resultCard(r: ExecutionResult, chain: ChainInfo): string {
  const explorer = chain.block_explorer_url ? `${chain.block_explorer_url.replace(/\/$/, "")}/tx/${r.hash}` : undefined;
  const lines = [`<b>Swap confirmed</b> on ${esc(chain.name)}`, explorer ? `<a href="${explorer}">${short(r.hash)}</a>` : `<code>${r.hash}</code>`, ""];
  for (const o of r.outputs) lines.push(`• received ${trim(o.received)} ${esc(o.symbol)} (expected ${trim(o.expected)}, min ${trim(o.minimum)})`);
  const spent = r.balanceChanges.filter((c) => c.delta.startsWith("-"));
  if (spent.length) lines.push("", ...spent.map((c) => `• spent ${trim(c.delta.slice(1))} ${esc(c.symbol)}`));
  if (r.approvalHashes.length) lines.push("", `Approvals: ${r.approvalHashes.map((h) => `<code>${short(h)}</code>`).join(", ")}`);
  lines.push("", `Block ${r.blockNumber}, gas used ${r.gasUsed}`);
  return lines.join("\n");
}

export function explorerAddress(chain: ChainInfo, a: Address): string {
  return chain.block_explorer_url ? `<a href="${chain.block_explorer_url.replace(/\/$/, "")}/address/${a}">${short(a)}</a>` : `<code>${a}</code>`;
}
