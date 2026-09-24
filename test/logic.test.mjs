import assert from "node:assert/strict";
import * as L from "../public/logic.js";

const sum = o => Object.values(o).reduce((a, b) => a + b, 0);
let n = 0; const t = (name, fn) => { fn(); n++; console.log("ok -", name); };

t("equal split 100 / 3 sums exactly", () => {
  const s = L.splitEqual(10000, ["a", "b", "c"]);
  assert.equal(sum(s), 10000); assert.deepEqual(Object.values(s).sort(), [3333, 3333, 3334]);
});
t("allocate negative (discount)", () => {
  const s = L.allocate(-100, { a: 1, b: 2 });
  assert.equal(sum(s), -100); assert.equal(s.a, -33); assert.equal(s.b, -67);
});
t("equal expense in CNY", () => {
  const e = { thb: 495, currency: "CNY", amount: 100, rate: 4.95, payer: "a", participants: ["a", "b", "c"], splitMode: "equal" };
  const s = L.sharesOf(e); assert.equal(sum(s), 49500);
});
t("exact split + validation", () => {
  const e = { thb: 1000, payer: "a", participants: ["a", "b"], splitMode: "exact", exact: { a: 300, b: 700 } };
  assert.equal(L.validateExpense(e), ""); assert.deepEqual(L.sharesOf(e), { a: 30000, b: 70000 });
  assert.match(L.validateExpense({ ...e, exact: { a: 300, b: 600 } }), /ขาด 100/);
});
t("items split with service charge distributed proportionally", () => {
  // food 100 (a), 200 (b), shared 60 (a,b,c) + 10% service = 396 total
  const e = { thb: 396, currency: "THB", payer: "a", participants: ["a", "b", "c"], splitMode: "items",
    items: [{ name: "ข้าว", price: 100, who: ["a"] }, { name: "กุ้ง", price: 200, who: ["b"] }, { name: "น้ำ", price: 60, who: [] }] };
  const s = L.sharesOf(e);
  assert.equal(sum(s), 39600);
  assert.equal(s.c, 2200); // 20 + 10% = 22
  assert.equal(s.a, 13200); // 120 + 12
  assert.equal(s.b, 24200); // 220 + 22
});
t("items in CNY converted by rate", () => {
  const e = { thb: 99, currency: "CNY", rate: 4.95, payer: "a", participants: ["a", "b"], splitMode: "items",
    items: [{ name: "x", price: 10, who: ["a"] }, { name: "y", price: 10, who: ["b"] }] };
  const s = L.sharesOf(e); assert.equal(sum(s), 9900); assert.equal(s.a, 4950);
});
t("balances + settle up is zero-sum and clears debts", () => {
  const ex = [
    { thb: 3000, payer: "a", participants: ["a", "b", "c"], splitMode: "equal" },
    { thb: 600, payer: "b", participants: ["a", "b", "c"], splitMode: "equal" },
    { thb: 100, payer: "c", participants: ["c"], splitMode: "equal" },
  ];
  const b = L.balances(ex, ["a", "b", "c", "d"]);
  assert.equal(sum(Object.fromEntries(Object.entries(b).map(([k, v]) => [k, v.net]))), 0);
  assert.equal(b.a.net, 180000); assert.equal(b.b.net, -60000); assert.equal(b.c.net, -120000); assert.equal(b.d.net, 0);
  const tr = L.settleUp(b);
  assert.deepEqual(tr, [{ from: "c", to: "a", amount: 120000 }, { from: "b", to: "a", amount: 60000 }]);
  // record settlements -> all zero
  const after = L.balances([...ex, ...tr.map(x => ({ kind: "settle", payer: x.from, to: x.to, thb: x.amount / 100 }))]);
  for (const id in after) assert.equal(after[id].net, 0);
});
t("votes: one per person, latest device wins, pass/fail thresholds", () => {
  const p = { votes: { u1: { v: 1, who: "a", at: 1 }, u2: { v: 1, who: "a", at: 2 }, u3: { v: -1, who: "b", at: 1 }, u4: { v: 1, who: "c", at: 1 } } };
  const t1 = L.tally(p); assert.deepEqual(t1.up.sort(), ["a", "c"]); assert.deepEqual(t1.down, ["b"]);
  assert.equal(L.votesNeeded(5), 3); assert.equal(L.votesNeeded(4), 3); assert.equal(L.votesNeeded(1), 1);
  assert.equal(L.verdict(p, 5).state, "open");
  assert.equal(L.verdict(p, 3).state, "pass");
  assert.equal(L.verdict({ votes: { x: { v: -1, who: "a" }, y: { v: -1, who: "b" } } }, 3).state, "fail");
});
t("ranking puts most-voted first", () => {
  const r = L.rankProposals([
    { id: "low", votes: { a: { v: 1, who: "a" } }, createdMs: 1 },
    { id: "top", votes: { a: { v: 1, who: "a" }, b: { v: 1, who: "b" }, c: { v: 1, who: "c" } }, createdMs: 3 },
    { id: "mid", votes: { a: { v: 1, who: "a" }, b: { v: 1, who: "b" } }, createdMs: 2 },
  ]);
  assert.deepEqual(r.map(x => x.id), ["top", "mid", "low"]);
});
t("apply proposals: add/remove/move/swap/date/other", () => {
  const plan = { version: 1, days: [{ t: "D1", items: [["A", ""], ["B", "乙"]] }, { t: "D2", items: [["C", ""]] }] };
  let p = L.applyProposal(plan, { type: "add", day: 1, text: "D", zh: "" });
  assert.deepEqual(p.days[1].items.map(i => i[0]), ["C", "D"]); assert.equal(p.version, 2);
  assert.deepEqual(plan.days[1].items.length, 1, "original not mutated");
  p = L.applyProposal(p, { type: "move", day: 0, text: "B", toDay: 1 });
  assert.deepEqual(p.days[1].items.at(-1), ["B", "乙"]);
  p = L.applyProposal(p, { type: "remove", day: 0, text: "A" });
  assert.equal(p.days[0].items.length, 0);
  p = L.applyProposal(p, { type: "swap", day: 0, toDay: 1 });
  assert.equal(p.days[0].t, "D2");
  p = L.applyProposal(p, { type: "date", date: "2026-11-12" }); assert.equal(p.startDate, "2026-11-12");
  p = L.applyProposal(p, { type: "other", text: "งดเข้าร้านช้อป" }); assert.deepEqual(p.notes, ["งดเข้าร้านช้อป"]);
  assert.throws(() => L.applyProposal(p, { type: "remove", day: 0, text: "ไม่มี" }), /ไม่พบ/);
});
t("thai date + name match", () => {
  assert.equal(L.thaiDate("2026-11-12"), "12 พ.ย. 69"); assert.equal(L.thaiDate("2026-11-30", 2), "2 ธ.ค. 69");
  const m = [{ id: "1", name: "นกยูง" }, { id: "2", name: "Somchai" }, { id: "3", name: "บี" }];
  assert.equal(L.matchName("นางสาว นกยูง ม่วงเอี่ยม", m), "1");
  assert.equal(L.matchName("MR. SOMCHAI J", m), "2");
  assert.equal(L.matchName("ร้านอาหาร", m), null);
});
console.log(`\n${n} tests passed`);
