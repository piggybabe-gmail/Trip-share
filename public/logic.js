/* Trip Share — pure logic (no DOM, no Firebase). Money is handled in satang (integer, 1 บาท = 100). */

export const toS = v => Math.round((Number(v) || 0) * 100);
export const fromS = s => s / 100;

/** Pseudo-member id for the trip's central fund (เงินกองกลาง). */
export const FUND = "__fund";

/** Convert an amount to baht: CNY uses the rate, THB (or anything else) stays as is. Returns baht rounded to satang. */
export const toTHB = (amount, currency, rate) =>
  fromS(toS((Number(amount) || 0) * (currency === "CNY" ? (Number(rate) || 0) : 1)));

/** Does this document count in the money totals? Fund contributions count only after the owner confirms them. */
export const counts = e => !!e && (e.kind !== "fund" || e.confirmed === true);

/** Split an integer total across ids by weight, exactly (largest remainder). Works for negative totals too. */
export function allocate(totalS, weights) {
  const ids = Object.keys(weights).filter(id => weights[id] > 0);
  const out = {};
  if (!ids.length || !totalS) { ids.forEach(id => out[id] = 0); return out; }
  const sign = totalS < 0 ? -1 : 1, abs = Math.abs(totalS);
  const wsum = ids.reduce((a, id) => a + weights[id], 0);
  let given = 0;
  const rema = ids.map((id, i) => {
    const exact = abs * weights[id] / wsum, base = Math.floor(exact + 1e-9);
    out[id] = base; given += base;
    return { id, r: exact - base, i };
  });
  rema.sort((a, b) => b.r - a.r || a.i - b.i);
  for (let k = 0; k < abs - given; k++) out[rema[k % rema.length].id] += 1;
  if (sign < 0) ids.forEach(id => out[id] = -out[id]);
  return out;
}

export const splitEqual = (totalS, ids) => allocate(totalS, Object.fromEntries(ids.map(id => [id, 1])));

/** Per-person share (satang) of one expense document. */
export function sharesOf(e) {
  const total = toS(e.thb);
  if (e.kind === "fund") return { [FUND]: total };          // money put into the central fund
  if (e.kind === "settle") return e.to ? { [e.to]: total } : {};
  const parts = (e.participants || []).filter(Boolean);
  if (e.splitMode === "exact" && e.exact) {
    const out = {};
    for (const id of parts) out[id] = toS(e.exact[id]);
    return out;
  }
  if (e.splitMode === "items" && Array.isArray(e.items) && e.items.length) {
    const rate = e.currency === "CNY" ? (Number(e.rate) || 1) : 1;
    const base = {};
    parts.forEach(id => base[id] = 0);
    let itemsSum = 0;
    for (const it of e.items) {
      const p = toS((Number(it.price) || 0) * rate);
      itemsSum += p;
      const who = (it.who && it.who.length ? it.who : parts).filter(id => id in base || parts.includes(id));
      const sp = splitEqual(p, who.length ? who : parts);
      for (const id in sp) base[id] = (base[id] || 0) + sp[id];
    }
    const extra = total - itemsSum;               // service charge / VAT / discount / rounding
    const weights = Object.fromEntries(Object.entries(base).filter(([, v]) => v > 0));
    const ex = Object.keys(weights).length ? allocate(extra, weights) : splitEqual(extra, parts);
    const out = {};
    for (const id of new Set([...Object.keys(base), ...Object.keys(ex)])) out[id] = (base[id] || 0) + (ex[id] || 0);
    return out;
  }
  return splitEqual(total, parts.length ? parts : [e.payer]);
}

/** Validate a draft before saving. Returns an error message (Thai) or "". */
export function validateExpense(e) {
  if (!(toS(e.thb) > 0)) return "ใส่จำนวนเงินมากกว่า 0";
  if (!e.payer) return "เลือกคนที่จ่ายเงิน";
  if (e.kind === "fund") return e.payer === FUND ? "เลือกคนที่ใส่เงินเข้ากองกลาง" : "";
  if (e.kind === "settle") return e.to && e.to !== e.payer ? "" : "เลือกคนที่รับเงินคืน (ต้องไม่ใช่คนเดียวกับคนจ่าย)";
  if (!(e.participants || []).length) return "เลือกคนที่หารอย่างน้อย 1 คน";
  if (e.splitMode === "exact") {
    const sum = (e.participants || []).reduce((a, id) => a + toS(e.exact?.[id]), 0);
    const diff = toS(e.thb) - sum;
    if (diff !== 0) return `ยอดที่กำหนดเองรวมกัน ${fmt(fromS(sum))} ไม่เท่ากับยอดบิล ${fmt(e.thb)} (${diff > 0 ? "ขาด" : "เกิน"} ${fmt(Math.abs(fromS(diff)))})`;
  }
  if (e.splitMode === "items") {
    if (!(e.items || []).length) return "ยังไม่มีรายการในบิล เพิ่มรายการหรือเลือกหารเท่ากัน";
  }
  return "";
}

/** Balance per member: paid, owed (share), net (+ ได้คืน / − ต้องจ่าย), all in satang. */
export function balances(expenses, memberIds = []) {
  const b = {};
  const touch = id => (b[id] ||= { paid: 0, owed: 0, net: 0 });
  memberIds.forEach(touch);
  for (const e of expenses) {
    if (!e.payer || !counts(e)) continue;
    touch(e.payer).paid += toS(e.thb);
    const sh = sharesOf(e);
    for (const id in sh) touch(id).owed += sh[id];
  }
  for (const id in b) b[id].net = b[id].paid - b[id].owed;
  return b;
}

/** Central fund: confirmed money in, money paid out (bills + refunds), balance left, and contributions waiting for the owner. */
export function fundSummary(expenses) {
  let inS = 0, outS = 0, pendingS = 0;
  for (const e of expenses) {
    if (e.kind === "fund") { if (e.confirmed === true) inS += toS(e.thb); else pendingS += toS(e.thb); }
    else if (e.payer === FUND) outS += toS(e.thb);
  }
  return { in: inS, out: outS, balance: inS - outS, pending: pendingS };
}

/** Owner-editable estimate. item = { name, amount, currency: THB|CNY, mode: "group"|"person", div?: number }.
 *  group items are split by `div` people (or by n); person items are per head. Returns baht (not satang). */
export function estimate(items, n, rate) {
  const N = Math.max(1, Number(n) || 1);
  const rows = (items || []).map(it => {
    const thb = toTHB(it.amount, it.currency, rate);
    const d = it.mode === "group" ? Math.max(1, Number(it.div) || N) : 1;
    return { ...it, thb, per: it.mode === "group" ? thb / d : thb, groupTotal: it.mode === "group" ? thb : thb * N, by: d };
  });
  const perPerson = rows.reduce((a, r) => a + r.per, 0);
  return { rows, perPerson, group: rows.filter(r => r.mode === "group"), person: rows.filter(r => r.mode !== "group"), total: perPerson * N };
}

/** Minimal-ish transfers to settle up (greedy: biggest debtor pays biggest creditor). */
export function settleUp(bal) {
  const deb = [], cred = [];
  for (const id in bal) {
    const n = bal[id].net;
    if (n < 0) deb.push({ id, v: -n }); else if (n > 0) cred.push({ id, v: n });
  }
  deb.sort((a, b) => b.v - a.v); cred.sort((a, b) => b.v - a.v);
  const out = [];
  let i = 0, j = 0;
  while (i < deb.length && j < cred.length) {
    const amt = Math.min(deb[i].v, cred[j].v);
    if (amt > 0) out.push({ from: deb[i].id, to: cred[j].id, amount: amt });
    deb[i].v -= amt; cred[j].v -= amt;
    if (deb[i].v === 0) i++;
    if (cred[j].v === 0) j++;
  }
  return out;
}

/* ---------------- Plan & voting ---------------- */

/** Votes needed to pass: more than half of the "ไปแน่นอน" people (at least 1). */
export const votesNeeded = goCount => goCount > 0 ? Math.floor(goCount / 2) + 1 : 1;

/** Count votes, one per person (signup id), whatever device they voted from. */
export function tally(p) {
  const byWho = {};
  for (const [uid, v] of Object.entries(p.votes || {})) {
    if (!v) continue;
    const who = v.who || uid, prev = byWho[who];
    const at = v.at || 0;
    if (!prev || at >= prev.at) byWho[who] = { v: v.v, at };
  }
  const up = Object.entries(byWho).filter(([, x]) => x.v > 0).map(([w]) => w);
  const down = Object.entries(byWho).filter(([, x]) => x.v < 0).map(([w]) => w);
  return { up, down, score: up.length - down.length };
}

export function verdict(p, goCount) {
  const need = votesNeeded(goCount), t = tally(p);
  if (t.up.length >= need && t.up.length > t.down.length) return { ...t, need, state: "pass" };
  if (t.down.length >= need) return { ...t, need, state: "fail" };
  return { ...t, need, state: "open" };
}

/** Open proposals: most votes first — the top one is what the group wants most. */
export function rankProposals(list) {
  return [...list].sort((a, b) => {
    const ta = tally(a), tb = tally(b);
    return tb.score - ta.score || tb.up.length - ta.up.length || (a.createdMs || 0) - (b.createdMs || 0);
  });
}

const clone = o => JSON.parse(JSON.stringify(o));
const findItem = (day, text) => day.items.findIndex(([th]) => th.trim() === String(text).trim());

/** Apply a proposal to the plan. Returns a NEW plan; throws Error(Thai message) if it no longer fits. */
export function applyProposal(plan, p) {
  const np = clone(plan);
  np.days ||= []; np.notes ||= [];
  const day = i => {
    const d = np.days[i];
    if (!d) throw new Error(`ไม่มีวันที่ ${i + 1} ในแพลนแล้ว`);
    return d;
  };
  switch (p.type) {
    case "add": {
      const d = day(p.day);
      const pos = Number.isInteger(p.pos) ? Math.max(0, Math.min(p.pos, d.items.length)) : d.items.length;
      d.items.splice(pos, 0, [p.text.trim(), (p.zh || "").trim()]);
      break;
    }
    case "remove": {
      const d = day(p.day), k = findItem(d, p.text);
      if (k < 0) throw new Error(`ไม่พบ "${p.text}" ในวันที่ ${p.day + 1} แล้ว แพลนอาจเปลี่ยนไปก่อนหน้านี้`);
      d.items.splice(k, 1);
      break;
    }
    case "move": {
      const d = day(p.day), to = day(p.toDay), k = findItem(d, p.text);
      if (k < 0) throw new Error(`ไม่พบ "${p.text}" ในวันที่ ${p.day + 1} แล้ว แพลนอาจเปลี่ยนไปก่อนหน้านี้`);
      const [it] = d.items.splice(k, 1);
      to.items.push(it);
      break;
    }
    case "swap": {
      day(p.day); day(p.toDay);
      if (p.day === p.toDay) throw new Error("เลือกวันที่ต่างกัน");
      [np.days[p.day], np.days[p.toDay]] = [np.days[p.toDay], np.days[p.day]];
      break;
    }
    case "date": {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(p.date || "")) throw new Error("วันที่ไม่ถูกต้อง");
      np.startDate = p.date;
      break;
    }
    case "other": {
      np.notes.push(p.text.trim());
      break;
    }
    default: throw new Error("ไม่รู้จักประเภทข้อเสนอ");
  }
  np.version = (plan.version || 0) + 1;
  return np;
}

/** Human-readable one-liner for a proposal. */
export function describeProposal(p, plan) {
  const dn = i => `วันที่ ${i + 1}`;
  switch (p.type) {
    case "add": return `เพิ่ม "${p.text}" ใน${dn(p.day)}`;
    case "remove": return `ตัด "${p.text}" ออกจาก${dn(p.day)}`;
    case "move": return `ย้าย "${p.text}" จาก${dn(p.day)} ไป${dn(p.toDay)}`;
    case "swap": return `สลับ${dn(p.day)} (${plan?.days?.[p.day]?.t || ""}) กับ${dn(p.toDay)} (${plan?.days?.[p.toDay]?.t || ""})`;
    case "date": return `เลื่อนวันเดินทางเป็น ${thaiDate(p.date)}`;
    case "other": return p.text;
    default: return "ข้อเสนอ";
  }
}

/* ---------------- helpers ---------------- */
export const fmt = (v, d = 2) => {
  const n = Number(v) || 0;
  return n.toLocaleString("th-TH", { minimumFractionDigits: Number.isInteger(n) ? 0 : d, maximumFractionDigits: d });
};
const TH_M = ["ม.ค.", "ก.พ.", "มี.ค.", "เม.ย.", "พ.ค.", "มิ.ย.", "ก.ค.", "ส.ค.", "ก.ย.", "ต.ค.", "พ.ย.", "ธ.ค."];
export function thaiDate(iso, addDays = 0) {
  if (!iso) return "";
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + addDays));
  return `${dt.getUTCDate()} ${TH_M[dt.getUTCMonth()]} ${String(dt.getUTCFullYear() + 543).slice(-2)}`;
}

/** Match a name read from a slip ("นาย สมชาย ใจดี", "NOKYUNG") to a member id. */
export function matchName(name, members) {
  if (!name) return null;
  const norm = s => String(s).toLowerCase().replace(/^(นาย|นางสาว|นาง|น\.ส\.|ด\.ช\.|ด\.ญ\.|mr\.?|mrs\.?|ms\.?|miss)\s*/i, "").replace(/[\s.]/g, "");
  const n = norm(name);
  if (!n) return null;
  let best = null, bestLen = 0;
  for (const m of members) {
    const mn = norm(m.name);
    if (!mn) continue;
    if (n === mn) return m.id;
    if ((n.includes(mn) || mn.includes(n)) && mn.length > bestLen && Math.min(n.length, mn.length) >= 2) { best = m.id; bestLen = mn.length; }
  }
  return best;
}
