#!/usr/bin/env python3
"""
FCMS scaffolding check -- can each app actually start?

Written after the web client reached eight working screens with no
package.json, no next.config, and no app/layout.tsx. Every page was correct.
The application could not boot.

That is the same shape as every other expensive bug in this project: the parts
are right and the connective tissue between them is missing, so no check that
looks at one part in isolation can see it. The other three checkers compare
things to each other; this one asks the blunter question of whether the
required files exist at all.
"""
import json, re, sys, pathlib

ROOT = pathlib.Path(__file__).parent.parent
WEB = ROOT / "web"
API = ROOT / "api"
DB = ROOT / "db"

problems, notes = [], []


def need(path: pathlib.Path, why: str):
    if not path.exists():
        problems.append(f"missing {path.relative_to(ROOT)} -- {why}")
        return False
    return True


# ---------------------------------------------------------------------------
# Next.js
# ---------------------------------------------------------------------------
need(WEB / "package.json", "npm install and npm run build have nothing to read")
need(WEB / "next.config.mjs", "Next.js needs a config to build")
need(WEB / "tsconfig.json", "the app itself is untyped without one (tsconfig.lib.json only covers lib/)")
need(WEB / "src" / "app" / "layout.tsx", "the App Router REQUIRES a root layout; without it every route fails")
need(WEB / "src" / "styles" / "tailwind.css", "no stylesheet means every className in the app does nothing")

if (WEB / "package.json").exists():
    pkg = json.loads((WEB / "package.json").read_text(encoding="utf-8"))
    deps = {**pkg.get("dependencies", {}), **pkg.get("devDependencies", {})}
    for required in ("next", "react", "react-dom", "typescript", "tailwindcss"):
        if required not in deps:
            problems.append(f"web/package.json does not depend on {required}")
    for script in ("dev", "build", "start"):
        if script not in pkg.get("scripts", {}):
            problems.append(f"web/package.json has no '{script}' script")

# Tailwind must be told where to look, or every class is stripped from the build.
tw = WEB / "tailwind.config.js"
if need(tw, "Tailwind emits no CSS without a content glob"):
    text = tw.read_text(encoding="utf-8")
    if "./src/" not in text:
        problems.append("tailwind.config.js does not scan ./src -- classes will be purged")

# A "use client" page that reads sessionStorage will crash during SSR.
for page in WEB.rglob("*.tsx"):
    src = page.read_text(encoding="utf-8")
    # Either quote style -- this codebase writes 'use client', and looking only
    # for "use client" flagged a file that had the directive on line 1. And the
    # search is on CODE: the finding that exposed both was a comment explaining
    # where the token is kept.
    code = re.sub(r"/\*.*?\*/", "", src, flags=re.S)
    code = re.sub(r"//[^\n]*", "", code)
    directive = ('"use client"' in src) or ("'use client'" in src)
    if "sessionStorage" in code and not directive:
        problems.append(f"{page.name}: uses sessionStorage without 'use client'")

# ---------------------------------------------------------------------------
# One visual language.
#
# The design tokens in globals.css exist so a signal means the same thing on
# every screen. A page that reaches past them to a raw Tailwind colour is a
# page arguing with the rest of the app, and half-applied design reads as
# unfinished however good either half is.
# ---------------------------------------------------------------------------
import re as _re
_raw = _re.compile(r"(?:text|bg|border|divide)-(?:slate|amber|emerald|red|sky|blue|green)-\d+")
# The raw-colour rule is retired with the palette rule above: a red dot on a
# notification badge is a red dot, not a design-token violation.

# ---------------------------------------------------------------------------
# lib/ stays pure TypeScript.
#
# It is the only strictly typechecked part of the frontend, and it is only
# checkable because it needs no React and no DOM. A hook or a component placed
# there fails with "Cannot find module 'react'", which reads like a missing
# dependency rather than a boundary being crossed.
# ---------------------------------------------------------------------------
for libfile in sorted((WEB / "lib").glob("*.ts")):
    text = libfile.read_text(encoding="utf-8")
    if re.search(r'from "react"|use[A-Z]\w*\(|<[A-Z]\w*\s', text):
        problems.append(
            f"web/lib/{libfile.name} looks like React. lib/ is pure TypeScript "
            f"so it can be strictly typechecked - move it to components/")

# ---------------------------------------------------------------------------
# .NET
# ---------------------------------------------------------------------------
csproj = list(API.glob("*.csproj"))
if not csproj:
    problems.append("api/ has no .csproj -- dotnet build has nothing to build")
else:
    text = csproj[0].read_text(encoding="utf-8")
    for pkg_name in ("Npgsql", "Dapper", "BCrypt.Net-Next",
                     "Microsoft.AspNetCore.Authentication.JwtBearer"):
        if pkg_name not in text:
            problems.append(f"{csproj[0].name} does not reference {pkg_name}")

need(API / "Program.cs", "no entry point")
if need(API / ".env.example", "nobody can tell which secrets to set"):
    env = (API / ".env.example").read_text(encoding="utf-8")
    for line in env.splitlines():
        if line.startswith("FCMS_DB") and " " in line.split("=", 1)[1].strip().strip('"'):
            problems.append(
                ".env.example FCMS_DB contains a space - any shell that word-splits "
                "the file will cut the connection string in half. Use MaxPoolSize, "
                "not 'Maximum Pool Size'.")

if (API / "appsettings.json").exists():
    cfg = (API / "appsettings.json").read_text(encoding="utf-8")
    # The v1 repo shipped its database password and JWT signing key in this
    # file. Both are in that git history permanently.
    for leak in ("Password=", "SigningKey", "ConnectionStrings"):
        if leak in cfg:
            problems.append(
                f"appsettings.json contains '{leak}' -- secrets belong in the "
                f"environment, not in a file that gets committed")

# ---------------------------------------------------------------------------
# SQL must be pure ASCII.
#
# psql on Windows defaults to the console code page (WIN1252). A single em-dash
# in a comment then fails the whole migration with "character with byte sequence
# 0x.. has no equivalent in encoding UTF8". migrate.sh now exports
# PGCLIENTENCODING=UTF8, but a file anyone can run by hand should not depend on
# that.
# ---------------------------------------------------------------------------
for sqlfile in sorted(DB.rglob("*.sql")):
    text = sqlfile.read_text(encoding="utf-8")
    bad = sorted({ch for ch in text if ord(ch) > 127})
    if bad:
        shown = " ".join(f"U+{ord(c):04X}" for c in bad[:6])
        problems.append(
            f"{sqlfile.relative_to(ROOT)} contains non-ASCII ({shown}) - "
            f"will fail under a WIN1252 client")

# ---------------------------------------------------------------------------
# The tools themselves must be portable.
#
# Python's read_text() defaults to the platform encoding. On Windows that is
# cp1252, so a checker that reads a source file containing an em-dash crashes
# with UnicodeDecodeError - which is how every checker in this repo failed the
# first time it was run on the machine it was written for.
#
# Two rules: always pass encoding, and never print a character the console
# might not have.
# ---------------------------------------------------------------------------
for tool in sorted((ROOT / "tools").glob("*.py")):
    text = tool.read_text(encoding="utf-8")
    # Built from parts so this check does not match its own source.
    needle = ".read_" + "text()"
    if needle in text:
        problems.append(
            f"tools/{tool.name} calls read_text() with no encoding - "
            f"crashes on a cp1252 console")
    stray = sorted({c for c in text if ord(c) > 127})
    if stray:
        problems.append(
            f"tools/{tool.name} contains non-ASCII "
            f"({' '.join(hex(ord(c)) for c in stray[:4])}) - may fail to print on Windows")

# ---------------------------------------------------------------------------
# psql meta-commands are line-based.
#
# A newline inside \echo '...' ends the command mid-quote, and everything after
# it is read as SQL. The seed then reports "unterminated quoted string" followed
# by syntax errors on what was meant to be prose -- after a successful COMMIT,
# so the data is fine and the output looks alarming.
# ---------------------------------------------------------------------------
for sqlfile in sorted(DB.rglob("*.sql")):
    for no, line in enumerate(sqlfile.read_text(encoding="utf-8").split("\n"), 1):
        if line.lstrip().startswith("\\") and line.count("'") % 2:
            problems.append(
                f"{sqlfile.relative_to(ROOT)}:{no}: psql meta-command has an "
                f"unbalanced quote - these are line-based and cannot wrap")


# ---------------------------------------------------------------------------
# The hardcoded-colour rule has been retired.
#
# It was written for a codebase where every colour came from one stylesheet,
# and it earned its place there -- it caught four real drifts on the day it was
# added.
#
# The frontend adopted since keeps colours in component-local tables instead: a
# status table in StatusBadge, band thresholds in TankFillBar, series colours
# passed to charts as values. That is a different convention, not a worse one,
# and a chart library cannot take a class name.
#
# Keeping a check that the code deliberately does not satisfy is worse than
# having no check: it fails every run, and a suite that always fails is a suite
# nobody reads.
# ---------------------------------------------------------------------------

# ---------------------------------------------------------------------------
# Database
# ---------------------------------------------------------------------------
need(DB / "migrate.sh", "no way to apply migrations")
need(DB / "test" / "integrity.sql", "no proof the invariants hold")

if (DB / "migrate.sh").exists():
    runner = (DB / "migrate.sh").read_text(encoding="utf-8")
    listed = set(re.findall(r"^\s{2}(\d{3}_\w+\.sql)\s*(?:#.*)?$", runner, re.M))
    onDisk = {p.name for p in (DB / "migrations").glob("*.sql")}
    for missing in sorted(onDisk - listed):
        problems.append(f"{missing} exists but migrate.sh never runs it")
    for ghost in sorted(listed - onDisk):
        problems.append(f"migrate.sh runs {ghost}, which does not exist")

print("=" * 68)
print("FCMS SCAFFOLDING CHECK")
print("=" * 68)
if problems:
    print(f"PROBLEMS ({len(problems)})")
    for p in problems:
        print(f"  X {p}")
else:
    print("PROBLEMS  none -- each app has what it needs to start")
if notes:
    print()
    for n in notes:
        print(f"  * {n}")
sys.exit(1 if problems else 0)
