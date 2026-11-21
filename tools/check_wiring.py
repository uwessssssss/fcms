#!/usr/bin/env python3
"""
check_wiring.py -- does every call the browser makes reach a real endpoint?

check_contract.py answers a narrower question: which endpoints are never
called. It deliberately SKIPS any path built from a variable -- `/api/shifts/
${id}/close` -- because it cannot resolve them. That is most of the
interesting ones, and it meant the close, the preview, the return-to-tank and
the closure context were all wired by hand and verified by hand.

This resolves them the way the router does: a path segment built from a
template literal matches a route parameter. It then checks three things the
compiler cannot:

  * the PATH exists          - otherwise 404 the moment somebody clicks
  * the METHOD matches       - a POST to a GET-only route is 405
  * the BODY FIELDS exist    - a field the request record does not have is
                               dropped in silence, and a required one that is
                               missing arrives as null. Neither fails the
                               build; both fail the user.

Only object literals written inline at the call site are judged. A body passed
as a variable is left alone rather than guessed at.
"""
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).parent.parent
API = ROOT / "api"
WEB = ROOT / "web" / "src"

CS = {f: f.read_text(encoding="utf-8") for f in API.rglob("*.cs")}
TSX = {f: f.read_text(encoding="utf-8") for f in list(WEB.rglob("*.tsx")) + list(WEB.rglob("*.ts"))}


def strip_cs_comments(src: str) -> str:
    """Line comments out, strings kept: a route template lives in a string."""
    return re.sub(r"//[^\n]*", "", src)


# --- the route table -------------------------------------------------------
# group variable -> prefix, per file, then every Map* hung off it.
routes: list[tuple[str, str, str, str]] = []   # method, template, record, where
for f, raw in CS.items():
    src = strip_cs_comments(raw)
    groups = {m.group(1): m.group(2)
              for m in re.finditer(r"var\s+(\w+)\s*=\s*app\.MapGroup\(\"([^\"]+)\"\)", src)}
    for m in re.finditer(
            r"\b(\w+)\.Map(Get|Post|Put|Delete)\(\s*\"([^\"]*)\"\s*,\s*(?:async\s*)?\(([^)]*)\)",
            src, re.S):
        holder, method, template, args = m.groups()
        prefix = groups.get(holder, "" if holder == "app" else None)
        if prefix is None:
            continue
        full = (prefix + template).replace("//", "/") or "/"
        # the request record is the first argument that is a declared record
        record = ""
        for a in args.split(","):
            a = a.strip()
            tm = re.match(r"([A-Z]\w+)\s+\w+$", a)
            if tm and tm.group(1) not in ("Guid", "DateOnly", "DateTime", "CancellationToken",
                                          "HttpContext", "ClaimsPrincipal"):
                if re.search(rf"record {tm.group(1)}\(", "\n".join(CS.values())):
                    record = tm.group(1)
                    break
        routes.append((method.upper(), full, record, f.name))

# every record's property names, camelCased the way System.Text.Json sends them
records: dict[str, list[tuple[str, bool]]] = {}
ALL_CS = "\n".join(CS.values())
for m in re.finditer(r"public record (\w+)\(([^)]*)\)", ALL_CS, re.S):
    props = []
    for part in re.split(r",(?![^<>]*>)", m.group(2)):
        part = part.strip()
        if not part:
            continue
        pm = re.match(r"([\w<>?\[\], ]+?)\s+(\w+)(?:\s*=.*)?$", part)
        if pm:
            name = pm.group(2)
            optional = "?" in pm.group(1) or "=" in part
            props.append((name[0].lower() + name[1:], optional))
    records[m.group(1)] = props


def normalise(path: str) -> str:
    """A `${...}` segment is a route parameter; so is `{id:guid}`."""
    p = re.sub(r"\$\{[^}]*\}", "{p}", path)
    p = re.sub(r"\{[^}]*\}", "{p}", p)
    # Two interpolations in ONE segment -- `${key}${suffix}` where suffix is a
    # query string -- normalise to {p}{p}, which matches no route. Collapse
    # them: it is still one segment.
    p = re.sub(r"(?:\{p\})+", "{p}", p)
    p = p.split("?")[0].rstrip("/")
    return p or "/"


ROUTE_SET: dict[str, set[str]] = {}
for method, template, record, where in routes:
    ROUTE_SET.setdefault(normalise(template), set()).add(method)
ROUTE_RECORD = {(m, normalise(t)): r for m, t, r, _ in routes}

# --- what each route RETURNS -------------------------------------------------
#
# Keyed by (service type, method), never by method name alone: ListAsync and
# GetAsync exist on half a dozen services, and keying by name had the delivery
# list answering for the tank list and the station status answering for a
# shift. Both were phantom findings that looked alarming.
RETURNS: dict[tuple[str, str], str] = {}
for f, raw in CS.items():
    cls = ""
    for line in raw.split("\n"):
        cm = re.search(r"\bclass\s+(\w+)", re.sub(r"///[^\n]*", "", line))
        if cm:
            cls = cm.group(1)
        rm = re.search(r"public async Task<([\w<>,\s\?\[\]]+)>\s+(\w+)\s*\(", line)
        if rm and cls:
            RETURNS[(cls, rm.group(2))] = rm.group(1).strip()

ROUTE_RETURN: dict[tuple[str, str], str] = {}
for f, raw in CS.items():
    src = strip_cs_comments(raw)
    groups = {m.group(1): m.group(2)
              for m in re.finditer(r"var\s+(\w+)\s*=\s*app\.MapGroup\(\"([^\"]+)\"\)", src)}
    for m in re.finditer(
            # The tail is a LOOKAHEAD so it is read without being consumed.
            # Capturing it greedily swallowed the next two route declarations
            # in every endpoints file -- /current and /{id} simply vanished,
            # and the check quietly covered a third of what it claimed to.
            r"\b(\w+)\.Map(Get|Post|Put|Delete)\(\s*\"([^\"]*)\"\s*,\s*"
            r"(?:async\s*)?\(([^)]*)\)\s*=>(?=(.{0,300}))",
            src, re.S):
        holder, method, template, args, tail = m.groups()
        prefix = groups.get(holder, "" if holder == "app" else None)
        if prefix is None:
            continue
        full = normalise((prefix + template).replace("//", "/"))
        svc = {}
        for a in args.split(","):
            am = re.match(r"\s*([A-Z]\w+)\s+(\w+)\s*$", a)
            if am:
                svc[am.group(2)] = am.group(1)
        call = re.search(r"await\s+(\w+)\.(\w+)\(", tail)
        if call and call.group(1) in svc:
            rt = RETURNS.get((svc[call.group(1)], call.group(2)))
            if rt:
                ROUTE_RETURN[(method.upper(), full)] = rt

problems: list[str] = []
checked = 0

# `api` and `.get` may be split across lines -- the client is often called as
#     api
#       .get<Row[]>("/path")
# Requiring `api.get` missed 19 of 61 calls, a third of the surface, including
# the screen that loads companies. Worse, the coverage count I used to reassure
# myself used the SAME pattern, so it agreed with itself.
CALL = re.compile(
    r"api\s*\.\s*(get|post|put|del)<[^>]*>\(\s*[`'\"]([^`'\"]+)[`'\"]"
    r"\s*(?:,\s*(\{.*?\n\s*\})\s*(?:,|\)))?",
    re.S)

# The call's arguments, found by bracket depth -- NOT by the lazy body pattern
# in CALL. That pattern, with re.S, could run from one call's `{}` body across
# later lines to the next `}` followed by `,` or `)`, SWALLOWING every call in
# between. They were never checked: 9 of 175, including the expense create and
# the depot bulk sale, whose request fields were never compared with the
# server's records. Every "every call reaches a route" rested on 166.
HEAD = re.compile(r"api\s*\.\s*(get|post|put|del)<[^>]*>\(\s*[`'\"]([^`'\"]+)[`'\"]", re.S)


def _args(src: str, open_paren: int) -> str:
    """The text inside the call's parentheses, strings and templates skipped."""
    i, depth = open_paren, 0
    while i < len(src):
        c = src[i]
        if c in "'\"`":
            q = c
            i += 1
            while i < len(src) and src[i] != q:
                if src[i] == "\\":
                    i += 1
                elif q == "`" and src[i] == "$" and src[i + 1:i + 2] == "{":
                    d, i = 1, i + 2
                    while i < len(src) and d:
                        d += (src[i] == "{") - (src[i] == "}")
                        i += 1
                    continue
                i += 1
        elif c in "([{":
            depth += 1
        elif c in ")]}":
            depth -= 1
            if depth == 0:
                return src[open_paren + 1:i]
        i += 1
    return src[open_paren + 1:]


def _top_level_split(text: str) -> list[str]:
    out, depth, cur, i = [], 0, [], 0
    while i < len(text):
        c = text[i]
        if c in "'\"`":
            q = c
            j = i + 1
            while j < len(text) and text[j] != q:
                j += 2 if text[j] == "\\" else 1
            cur.append(text[i:j + 1])
            i = j + 1
            continue
        if c in "([{":
            depth += 1
        elif c in ")]}":
            depth -= 1
        if c == "," and depth == 0:
            out.append("".join(cur))
            cur = []
        else:
            cur.append(c)
        i += 1
    out.append("".join(cur))
    return [x.strip() for x in out]


class _Call:
    """Shaped like the regex match the rest of this file reads."""
    def __init__(self, src: str, m: "re.Match[str]"):
        self._src, self._m = src, m
        paren = src.index("(", m.start() + src[m.start():].index(">") )
        parts = _top_level_split(_args(src, paren))
        self._body = parts[1] if len(parts) > 1 and parts[1].startswith("{") else None
        self._text = src[m.start():paren + 2 + len(_args(src, paren))]

    def group(self, i: int = 0):
        if i == 0:
            return self._text
        if i == 3:
            return self._body
        return self._m.group(i)

    def start(self):
        return self._m.start()


for f, src in TSX.items():
    for m in (_Call(src, h) for h in HEAD.finditer(src)):
        verb, path, body = m.group(1), m.group(2), m.group(3)
        checked += 1
        method = {"get": "GET", "post": "POST", "put": "PUT", "del": "DELETE"}[verb]
        norm = normalise(path)
        rel = str(f).split("src/")[-1]
        if norm not in ROUTE_SET:
            problems.append(f"{rel}: {method} {path} - no such route")
            continue
        if method not in ROUTE_SET[norm]:
            problems.append(
                f"{rel}: {method} {path} - that path only answers "
                f"{', '.join(sorted(ROUTE_SET[norm]))}")
            continue
        # The response type the caller declares must be the one the endpoint
        # returns. A wrong one compiles and renders blank fields.
        declared = m.group(0)
        tsm = re.search(r"api\s*\.\s*\w+<([^>]*)>", declared)
        server = ROUTE_RETURN.get((method, norm), "")
        if tsm and server:
            ts = tsm.group(1).replace("[]", "").split("|")[0].strip()
            core = re.sub(r"^(IReadOnlyList|List|IEnumerable)<|>$|\?", "", server).strip()
            simple = {"Guid", "object", "int", "long", "bool", "string", "decimal", "void"}
            if (ts and ts != "unknown" and not ts.startswith("{")
                    and core not in simple and ts != core):
                problems.append(
                    f"{rel}: {method} {path} is read as {ts} but the endpoint "
                    f"returns {server} - the fields will be blank")

        record = ROUTE_RECORD.get((method, norm), "")
        if not record or record not in records or not body:
            continue
        known = {n for n, _ in records[record]}
        required = {n for n, opt in records[record] if not opt}
        # The body's TOP-LEVEL keys, found by tracking brace depth.
        #
        # Two earlier versions got this wrong in opposite directions. Matching
        # `name: value` alone missed shorthand (`sku,`), and anchoring to the
        # start of a line missed fields sharing one -- `litres: x, purpose: y`
        # reported `purpose` as missing when it was right there. Matching keys
        # anywhere would pick up the keys of NESTED objects and call them
        # unknown fields. Depth is the only thing that answers all three.
        # A key is an identifier that FOLLOWS `{` or `,` at depth 1. Without
        # the lookbehind, values matched too -- `nozzleId: null,` yielded
        # `null`, `slice(0, 8)` yielded `8`, and a regex flag yielded `g`.
        # Parentheses count toward depth for the same reason: anything inside
        # a call is not a field of this object.
        # COMMENTS OUT FIRST. A key preceded by an explanatory comment has
        # comment text before it, not `{` or `,`, so the lookbehind fails and
        # a field that is plainly being sent reads as missing. Four of them did.
        # (This is the fifth rule today that a comment has broken. A comment is
        # not code -- strip it before parsing anything.)
        body = re.sub(r"//[^\n]*", "", body)
        sent = set()
        depth = 0
        for tok in re.finditer(r"[{}\[\]()]|(?<=[{,])\s*(\w+)\s*(?=[,:}])", body):
            ch = tok.group(0).strip()
            if ch in ("{", "[", "("):
                depth += 1
            elif ch in ("}", "]", ")"):
                depth -= 1
            elif depth == 1 and tok.group(1):
                sent.add(tok.group(1))
        if "..." in body:
            continue                      # a spread: what it carries is unknown here
        unknown = sorted(sent - known)
        if unknown:
            problems.append(
                f"{rel}: {method} {path} sends {', '.join(unknown)} - "
                f"{record} has no such field, so it is dropped in silence")
        missing = sorted(required - sent)
        if missing:
            problems.append(
                f"{rel}: {method} {path} omits {', '.join(missing)} - "
                f"{record} requires it, so it arrives as null")

print("=" * 70)
print("FRONTEND -> API WIRING")
print("  paths, methods and request bodies, including the dynamic ones")
print("=" * 70)
print(f"routes {len(routes)}  calls checked {checked}")
if problems:
    print(f"\nPROBLEMS ({len(problems)})")
    for p in problems:
        print("  X", p)
else:
    print("\nPROBLEMS  none -- every call reaches a route that accepts it")
sys.exit(1 if problems else 0)
