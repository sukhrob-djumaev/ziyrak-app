#!/usr/bin/env python3
"""Build the L1.4 human review sheet from an R2_DUMP file (see docs/r2-human-review-rubric.md).

Usage: r2-review-sheet.py <all-turns.json> <cases.json> <out-dir> [per-category=6]
Writes review-sheet.md (no scorer verdicts) and answer-key.json (verdicts, kept apart so the reader samples blind).
Sample: every scorer failure, plus an evenly spaced pick of at least N turns per category chosen from id order, not from verdicts.
"""
import json, sys, os

dump = json.load(open(sys.argv[1]))
cases = {c["id"]: c for c in json.load(open(sys.argv[2]))["cases"]}
out = sys.argv[3]
n = int(sys.argv[4]) if len(sys.argv) > 4 else 6
os.makedirs(out, exist_ok=True)

dump.sort(key=lambda r: (r["category"], r["id"], r["rep"], r["turn"]))
chosen = {}
for cat in sorted({r["category"] for r in dump}):
    rows = [r for r in dump if r["category"] == cat]
    step = max(1, len(rows) // n)
    for r in rows[::step][:n] if len(rows) > n else rows:
        chosen[(r["id"], r["rep"], r["turn"])] = r
for r in dump:
    if not r["pass"] and not r["inconclusive"]:
        chosen[(r["id"], r["rep"], r["turn"])] = r

sample = sorted(chosen.values(), key=lambda r: (r["category"], r["id"], r["rep"], r["turn"]))
md = ["# L1.4 human review sheet", "", "Score each reply 0/1/2 on: Grounded, Honest about limits, Right hand-off, Clear and safe (docs/r2-human-review-rubric.md). Any 0 on the first two is a defect.", f"Turns in sample: {len(sample)}", ""]
for k, r in enumerate(sample, 1):
    c = cases[r["id"]]
    prior = [f"- Customer: {t['user']}" for t in c["turns"][: r["turn"]]]
    md += [f"## {k}. {r['id']} (rep {r['rep']}, turn {r['turn'] + 1}) - {r['category']}", f"Business: {c['business']}", "Knowledge:"]
    md += [f"- {x['title']}: {x['content']}" for x in c["knowledge"]]
    if c.get("tool"): md.append(f"Tool available: {c['tool']}")
    md += prior + [f"**Customer:** {r['user']}", f"**Reply:** {r['reply']}", f"**Handed off to a person:** {'yes' if r['escalated'] else 'no'}",
           "Scores (G / H / O / C): ___  Defect: ___  Note: ___", ""]
open(os.path.join(out, "review-sheet.md"), "w").write("\n".join(md))
json.dump([{k: r[k] for k in ("id", "rep", "turn", "category", "pass", "inconclusive")} for r in sample], open(os.path.join(out, "answer-key.json"), "w"), indent=2)
print(len(sample), "turns")
