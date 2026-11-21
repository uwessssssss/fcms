#!/usr/bin/env python3
"""
FCMS call-site arity check.

This is a compiler's job. The compiler is not available in this environment, so
every C# error arrives at the far end of a download-extract-build cycle, and
three of them in a row have now been argument-count mismatches introduced by a
scripted edit that matched some call sites and not others.

The specific failure it exists for:

    await Write(ctx, 503, "DATABASE_BUSY", "..." + "...");
                                                          ^ missing `detail`

An edit added the fifth argument to the calls written on one line and missed
the two written as string concatenations, because the search string assumed a
shape that only three of the five had.

Counting arguments requires skipping STRING LITERALS. My first two attempts at
this by hand both mis-counted, because a message like
"If this keeps happening, " contains a comma and reads as an argument
separator. That is why this is a file rather than a one-off command.

Scope: methods declared and called within the same file. That covers the
private helpers where scripted edits do their damage, and avoids pretending to
resolve overloads across a whole assembly, which this cannot do.
"""
import re
import sys
import pathlib

ROOT = pathlib.Path(__file__).parent.parent
API = ROOT / "api"

problems: list[str] = []


def split_top_level(text: str) -> list[str]:
    """
    Split on commas that are genuinely argument separators.

    Skips anything inside brackets, string literals, verbatim strings, raw
    string literals and character literals. A comma inside any of those is
    punctuation, not a separator.
    """
    parts, buf, depth, i, n = [], [], 0, 0, len(text)
    while i < n:
        ch = text[i]

        # raw string literal
        if text[i:i + 3] == '"""':
            end = text.find('"""', i + 3)
            i = n if end < 0 else end + 3
            buf.append('""')
            continue

        # verbatim string
        if ch == "@" and i + 1 < n and text[i + 1] == '"':
            i += 2
            while i < n:
                if text[i] == '"' and text[i:i + 2] != '""':
                    break
                i += 2 if text[i:i + 2] == '""' else 1
            i += 1
            buf.append('""')
            continue

        if ch == '"':
            i += 1
            while i < n and text[i] != '"':
                i += 2 if text[i] == "\\" else 1
            i += 1
            buf.append('""')
            continue

        if ch == "'":
            i += 1
            while i < n and text[i] != "'":
                i += 2 if text[i] == "\\" else 1
            i += 1
            buf.append("''")
            continue

        if ch in "([{<":
            depth += 1
        elif ch in ")]}>":
            depth -= 1

        if ch == "," and depth == 0:
            parts.append("".join(buf))
            buf = []
        else:
            buf.append(ch)
        i += 1

    if "".join(buf).strip():
        parts.append("".join(buf))
    return parts


def call_args(src: str, start: int) -> str | None:
    """Return the argument text of a call whose open paren follows `start`."""
    i = src.find("(", start)
    if i < 0:
        return None
    depth, j, n = 0, i, len(src)
    while j < n:
        ch = src[j]
        if ch == '"':
            j += 1
            while j < n and src[j] != '"':
                j += 2 if src[j] == "\\" else 1
        elif ch == "(":
            depth += 1
        elif ch == ")":
            depth -= 1
            if depth == 0:
                return src[i + 1: j]
        j += 1
    return None


for f in sorted(API.rglob("*.cs")):
    src = f.read_text(encoding="utf-8")

    # private/static helpers declared in this file, with their arity range
    declared: dict[str, tuple[int, int]] = {}
    for m in re.finditer(
            r"(?:private|internal|protected)\s+(?:static\s+)?(?:async\s+)?"
            r"[\w<>?\[\],\s]+?\s+(\w+)\s*\(", src):
        args = call_args(src, m.end() - 1)
        if args is None:
            continue
        params = [p for p in split_top_level(args) if p.strip()]
        # `params T[] x` accepts ANY number of arguments, including none. Counting
        # it as one parameter flagged every call to RequireAny("a", "b", "c") as
        # passing too many -- a checker that did not know a language feature.
        variadic = any(p.strip().startswith("params ") for p in params)
        fixed = [p for p in params if not p.strip().startswith("params ")]
        required = sum(1 for p in fixed if "=" not in p)
        declared[m.group(1)] = (required, 10**6 if variadic else len(fixed))

    for name, (lo, hi) in declared.items():
        for m in re.finditer(rf"(?<![\w.]){re.escape(name)}\s*\(", src):
            # skip the declaration itself
            before = src[max(0, m.start() - 90): m.start()]
            if re.search(r"(?:private|internal|protected|public)\s", before) and \
               re.search(r"\)\s*$", before.strip()) is None and \
               re.search(r"[\w>?\]]\s+$", before):
                continue
            args = call_args(src, m.end() - 1)
            if args is None:
                continue
            count = len([p for p in split_top_level(args) if p.strip()])
            if not (lo <= count <= hi):
                line = src[: m.start()].count("\n") + 1
                want = f"{lo}" if lo == hi else f"{lo} to {hi}"
                problems.append(
                    f"{f.name}:{line}: {name}(...) called with {count} argument(s), "
                    f"declared to take {want}")

print("=" * 70)
print("CALL-SITE ARITY")
print("=" * 70)
print()
if problems:
    print(f"PROBLEMS ({len(set(problems))})")
    for p in sorted(set(problems)):
        print("  X", p)
else:
    print("PROBLEMS  none -- every in-file call matches its declaration")

sys.exit(1 if problems else 0)
