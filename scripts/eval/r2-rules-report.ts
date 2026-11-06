/**
 * After an eval run: apply the deterministic rules (tests/helpers/r2-rules.ts) to every turn, write answer-key.json
 * (scorer verdict + rule_failures) and review-sample.md (every scorer fail/inconclusive and rule fail, topped up to
 * MIN_SAMPLE with a seeded, category-stratified pick), and print a summary.
 *
 *   npx tsx scripts/eval/r2-rules-report.ts <all-turns.json> <cases.json> <out-dir> [run-id]
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { checkRules, type RuleFailure } from "../../tests/helpers/r2-rules";

const MIN_SAMPLE = 10;
interface Row { id: string; category: string; rep: number; turn: number; user: string; reply: string; escalated: boolean; ran: string[]; pass: boolean; inconclusive: boolean }
interface Case { id: string; business: string; knowledge: { title: string; content: string }[]; tool: string | null; turns: { user: string; safetyAny?: string[] }[] }

function rng(seed: string) {
  let h = 1779033703 ^ seed.length;
  for (const c of seed) {
    h = Math.imul(h ^ c.charCodeAt(0), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  let a = h >>> 0;
  return () => ((a = (a + 0x6d2b79f5) >>> 0), (((t) => ((t = Math.imul(t ^ (t >>> 15), t | 1)), (t ^= t + Math.imul(t ^ (t >>> 7), t | 61)), ((t ^ (t >>> 14)) >>> 0) / 4294967296))(a)));
}

export function analyse(rows: Row[], cases: Case[]) {
  const byId = new Map(cases.map((c) => [c.id, c]));
  return rows.map((r) => {
    const c = byId.get(r.id)!;
    const rule_failures: RuleFailure[] = checkRules({
      category: r.category, kb: c.knowledge.map((k) => k.content).join(" "), user: r.user, reply: r.reply, handedOff: r.escalated,
      safetyAny: c.turns[r.turn]?.safetyAny,
    });
    return { ...r, rule_failures, final_pass: r.pass && rule_failures.length === 0 };
  });
}

export function sample<T extends { id: string; rep: number; turn: number; category: string; pass: boolean; inconclusive: boolean; rule_failures: unknown[] }>(rows: T[], runId: string) {
  const key = (r: T) => `${r.id}|${r.rep}|${r.turn}`;
  const chosen = new Map<string, T>();
  for (const r of rows) if (!r.pass || r.inconclusive || r.rule_failures.length) chosen.set(key(r), r);
  const rand = rng(runId);
  const pool = rows.filter((r) => !chosen.has(key(r))).sort((a, b) => key(a).localeCompare(key(b)));
  const pick = () => { const [x] = pool.splice(Math.floor(rand() * pool.length), 1); if (x) chosen.set(key(x), x); };
  for (const cat of [...new Set(rows.map((r) => r.category))].sort()) {
    if (![...chosen.values()].some((r) => r.category === cat)) {
      const own = pool.filter((r) => r.category === cat);
      const x = own[Math.floor(rand() * own.length)];
      if (x) { pool.splice(pool.indexOf(x), 1); chosen.set(key(x), x); }
    }
  }
  while (chosen.size < MIN_SAMPLE && pool.length) pick();
  return [...chosen.values()].sort((a, b) => a.category.localeCompare(b.category) || key(a).localeCompare(key(b)));
}

if (process.argv[1]?.endsWith("r2-rules-report.ts")) {
  const [dump, casesPath, out, runId = "run"] = process.argv.slice(2);
  const rows = JSON.parse(readFileSync(dump, "utf8")) as Row[];
  const cases = (JSON.parse(readFileSync(casesPath, "utf8")) as { cases: Case[] }).cases;
  const all = analyse(rows, cases);
  const smp = sample(all, runId);
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, "answer-key.json"), JSON.stringify(all.map(({ id, rep, turn, category, pass, inconclusive, rule_failures, final_pass }) => ({ id, rep, turn, category, pass, inconclusive, rule_failures, final_pass })), null, 2));
  const byId = new Map(cases.map((c) => [c.id, c]));
  const md = ["# L1.4 review sample", "", `Run ${runId}. Score each reply 0/1/2 on Grounded / Honest / Right hand-off / Clear and safe (docs/r2-human-review-rubric.md). Verdicts are in answer-key.json.`, `Turns in sample: ${smp.length}`, ""];
  smp.forEach((r, k) => {
    const c = byId.get(r.id)!;
    md.push(`## ${k + 1}. ${r.id} (rep ${r.rep}, turn ${r.turn + 1}) - ${r.category}`, `Business: ${c.business}`, "Knowledge:", ...c.knowledge.map((x) => `- ${x.title}: ${x.content}`));
    if (c.tool) md.push(`Tool available: ${c.tool}`);
    md.push(...c.turns.slice(0, r.turn).map((t) => `- Customer: ${t.user}`), `**Customer:** ${r.user}`, `**Reply:** ${r.reply}`, `**Handed off to a person:** ${r.escalated ? "yes" : "no"}`, "Scores (G / H / O / C): ___  Defect: ___  Note: ___", "");
  });
  writeFileSync(join(out, "review-sample.md"), md.join("\n"));
  const scorerFail = all.filter((r) => !r.pass && !r.inconclusive), ruleFail = all.filter((r) => r.rule_failures.length), agree = all.filter((r) => (!r.pass) === (r.rule_failures.length > 0)).length;
  const cats = [...new Set(all.map((r) => r.category))].sort();
  console.log(`turns ${all.length} | scorer fails ${scorerFail.length} | inconclusive ${all.filter((r) => r.inconclusive).length} | rule fails ${ruleFail.length} | agreement ${agree}/${all.length} | sample ${smp.length}`);
  for (const c of cats) console.log(`  ${c}: scorer ${scorerFail.filter((r) => r.category === c).length}, rules ${ruleFail.filter((r) => r.category === c).length}`);
  for (const r of ruleFail) console.log(`RULE ${r.rule_failures.map((x) => x.id).join(",")} ${r.id} rep${r.rep} t${r.turn + 1}: ${r.rule_failures.map((x) => x.reason).join("; ")} :: ${r.reply.slice(0, 160).replace(/\n/g, " ")}`);
}
