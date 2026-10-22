#!/usr/bin/env python3
"""Keep .agent/CURRENT.md and .agent/HANDOFF.md small by moving old sections to docs/state-archive/.

CURRENT.md: sections starting with "## Update" beyond the newest KEEP_UPDATES are archived.
HANDOFF.md: sections starting with "# Latest session" beyond the newest KEEP_SESSIONS are archived.
Idempotent; only touches those two files and docs/state-archive/*-archive.md.
"""
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parents[2]
KEEP_UPDATES = 2
KEEP_SESSIONS = 1
ARCHIVE = ROOT / "docs" / "state-archive"


def split(text, marker):
    parts = re.split(rf"(?m)^(?={re.escape(marker)})", text)
    return parts[0], parts[1:]


def archive(path, marker, keep, dest):
    if not path.exists():
        return 0
    head, sections = split(path.read_text(), marker)
    if len(sections) <= keep:
        return 0
    # CURRENT.md appends newest last; HANDOFF.md puts newest first.
    newest_last = marker.startswith("## Update")
    old = sections[:-keep] if newest_last else sections[keep:]
    kept = sections[-keep:] if newest_last else sections[:keep]
    ARCHIVE.mkdir(parents=True, exist_ok=True)
    with (ARCHIVE / dest).open("a") as f:
        f.write("".join(s.rstrip("\n") + "\n\n" for s in old))
    path.write_text(head + "".join(kept))
    return len(old)


moved = archive(ROOT / ".agent" / "CURRENT.md", "## Update", KEEP_UPDATES, "current-archive.md")
moved += archive(ROOT / ".agent" / "HANDOFF.md", "# Latest session", KEEP_SESSIONS, "handoff-archive.md")
print(f"state archive: moved {moved} old section(s)" if moved else "state archive: nothing to move")
sys.exit(0)
