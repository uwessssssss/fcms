#!/usr/bin/env python3
"""
FCMS C# <-> TypeScript drift check.

The API and the client agree on about sixty shapes and nothing enforces it.
A field renamed on one side becomes `undefined` on the other, which React
renders as an empty cell rather than an error -- so a money column silently
goes blank and nobody finds out until a reconciliation fails.

This compares every C# type that has a TypeScript counterpart, on names and on
nullability. Nullability matters as much as names: a C# `decimal?` declared as
`number` in TypeScript means the screen has no null guard where the server can
send one.

The TypeScript parser counts braces rather than matching to the first `}` --
an interface containing a nested object type otherwise truncates, and its
nested fields read as top-level ones. That produced two false positives on its
first run, and a checker with false positives gets ignored.
"""
import re
import sys
import pathlib

ROOT = pathlib.Path(__file__).parent.parent
found: list[str] = []


def parse_ts_interfaces(text: str) -> dict[str, dict[str, str]]:
    out: dict[str, dict[str, str]] = {}
    for m in re.finditer(r"export interface (\w+) \{", text):
        name = m.group(1)
        i, depth = m.end() - 1, 0
        while i < len(text):
            if text[i] == "{":
                depth += 1
            elif text[i] == "}":
                depth -= 1
                if depth == 0:
                    break
            i += 1
        body = text[m.end(): i]
        # blank out nested object literals so their fields are not read as ours
        flat, d, buf = "", 0, []
        for ch in body:
            if ch == "{":
                d += 1
            elif ch == "}":
                d -= 1
                continue
            if d == 0:
                flat += ch
        props = {}
        for line in flat.split("\n"):
            pm = re.match(r"\s*(\w+)(\??):\s*(.+?);", line)
            if pm:
                props[pm.group(1)] = pm.group(3).strip() + ("|undefined" if pm.group(2) else "")
        out[name] = props
    return out


cs_types: dict[str, dict[str, str]] = {}
for f in (ROOT / "api").rglob("*.cs"):
    src = f.read_text(encoding="utf-8")
    for m in re.finditer(
            r"public sealed class (\w+)\s*\n\{\n((?:\s*(?:///[^\n]*\n)?\s*public [^\n]+\n)+)\}", src):
        props = {}
        for line in m.group(2).split("\n"):
            pm = re.match(r"\s*public\s+([\w<>\[\],\s]+?\??)\s+(\w+)\s*\{ get; set; \}", line)
            if pm:
                props[pm.group(2)] = pm.group(1).strip()
        if props:
            cs_types[m.group(1)] = props
    for m in re.finditer(r"public record (\w+)\s*\(([^;]*?)\)\s*;", src, re.S):
        props = {}
        for part in re.split(r",(?![^<>()]*[>)])", m.group(2)):
            pm = re.match(r"\s*([\w<>\[\],\s?]+?)\s+(\w+)\s*$", part.strip())
            if pm:
                props[pm.group(2)] = pm.group(1).strip()
        if props:
            cs_types[m.group(1)] = props

# The adopted frontend declares its shapes inline in each screen rather than in
# one shared file, so there is nothing yet to compare the C# records against.
#
# This check earned its place -- it caught a nullability mismatch and a renamed
# field before either reached a build. It should be restored as the screens are
# wired to the real API: collect the shapes into web/src/types/api.ts and it
# starts working again with no other change.
ts_file = ROOT / "web" / "src" / "types" / "api.ts"
if not ts_file.exists():
    print("=" * 70)
    print("C# <-> TYPESCRIPT DRIFT")
    print("=" * 70)
    print()
    print("  SKIPPED -- web/src/types/api.ts does not exist yet.")
    print("  The adopted frontend declares its shapes inline per screen. Collect")
    print("  them into that file as each screen is wired to the API and this")
    print("  check resumes.")
    sys.exit(0)

ts_types = parse_ts_interfaces(ts_file.read_text(encoding="utf-8"))


def camel(s: str) -> str:
    return s[0].lower() + s[1:] if s else s


shared = sorted(set(cs_types) & set(ts_types))
for name in shared:
    cs, ts = cs_types[name], ts_types[name]
    for prop, typ in cs.items():
        c = camel(prop)
        if c not in ts:
            found.append(f"{name}.{c} ({typ}) is sent by the server and not declared")
            continue
        cs_null = typ.endswith("?")
        ts_null = "null" in ts[c] or "undefined" in ts[c]
        if cs_null and not ts_null:
            found.append(
                f"{name}.{c}: C# {typ} can be null, TypeScript {ts[c]} cannot - "
                f"the screen has no guard where the server has a hole")
    for c in ts:
        if c not in {camel(x) for x in cs}:
            found.append(f"{name}.{c} is declared but the server never sends it")

print("=" * 70)
print("C# <-> TYPESCRIPT DRIFT")
print("=" * 70)
print(f"shapes compared: {len(shared)}")
print()
if found:
    print(f"PROBLEMS ({len(set(found))})")
    for x in sorted(set(found)):
        print("  X", x)
else:
    print("PROBLEMS  none -- the API and the client agree")
sys.exit(1 if found else 0)
