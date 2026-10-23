#!/usr/bin/env python3
"""Token usage of this Claude session (and its helper agents) since a time, for the per-task log.

  usage.py --since 2026-10-18T09:12:00Z [--session <session-id>]

Without --session it reads the most recently written session transcript of the current folder, i.e. the
session that is running this command. Prints one line: input, cache write, cache read, output tokens.
"""
import argparse
import glob
import json
import os
import sys

p = argparse.ArgumentParser()
p.add_argument("--since", help="ISO time, e.g. 2026-10-18T09:12:00Z")
p.add_argument("--session", help="session id (default: the newest transcript of this folder)")
p.add_argument("--context", action="store_true",
               help="print only the size of the main conversation's last turn (tokens it re-reads every step)")
a = p.parse_args()
if not a.context and not a.since:
    p.error("--since is required unless --context is given")

base = os.environ.get("CLAUDE_CONFIG_DIR", os.path.expanduser("~/.claude"))
project = os.path.join(base, "projects", os.getcwd().replace("/", "-").replace(".", "-"))
if a.session:
    main = os.path.join(project, a.session + ".jsonl")
else:
    found = glob.glob(os.path.join(project, "*.jsonl"))
    if not found:
        sys.exit(f"usage.py: no transcripts in {project}")
    main = max(found, key=os.path.getmtime)
session = os.path.splitext(main)[0]

if a.context:
    last = 0
    with open(main) as fh:
        for line in fh:
            try:
                o = json.loads(line)
            except ValueError:
                continue
            u = (o.get("message") or {}).get("usage") if o.get("type") == "assistant" else None
            if u:
                last = sum(u.get(k) or 0 for k in ("input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"))
    print(f"context {last:,} tokens ({os.path.basename(session)})")
    sys.exit(0)

files = [main] + glob.glob(os.path.join(session, "subagents", "*.jsonl"))

since = a.since.replace("Z", "+00:00")
tot = {"input_tokens": 0, "cache_creation_input_tokens": 0, "cache_read_input_tokens": 0, "output_tokens": 0}
for f in files:
    with open(f) as fh:
        for line in fh:
            try:
                o = json.loads(line)
            except ValueError:
                continue
            if o.get("type") != "assistant" or o.get("timestamp", "").replace("Z", "+00:00") < since:
                continue
            u = (o.get("message") or {}).get("usage") or {}
            for k in tot:
                tot[k] += u.get(k) or 0

print(f"in {tot['input_tokens']:,} · cache-write {tot['cache_creation_input_tokens']:,} · "
      f"cache-read {tot['cache_read_input_tokens']:,} · out {tot['output_tokens']:,}  "
      f"({os.path.basename(session)}, {len(files) - 1} helper transcript(s))")
