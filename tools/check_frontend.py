#!/usr/bin/env python3
"""
FCMS frontend hygiene check.

Every bug this catches was created by a scripted edit whose anchor stopped
matching after an EARLIER scripted edit. That has now happened five times in
this codebase:

  * an import added for a conversion that then did not apply, leaving four
    screens on inline banners while the rest used toasts
  * `flash` state still being set after the thing that rendered it was removed
  * `useMemo` imported into a file that no longer memoises anything

None of it is caught by the other checkers, because each file is internally
consistent -- the damage is that a file half-changed and nobody noticed. The
compiler would flag some of it, and the compiler is not available here.

Also checks the things that make a screen feel finished rather than scaffolded:
every screen handles loading, every list says something when it is empty, and
every input has a label.
"""
import re
import sys
import pathlib

ROOT = pathlib.Path(__file__).parent.parent
APP = ROOT / "web" / "src" / "app"
COMPONENTS = ROOT / "web" / "src" / "components"

problems: list[str] = []
notes: list[str] = []

pages = sorted(APP.rglob("*.tsx")) + sorted(COMPONENTS.rglob("*.tsx"))
if not pages:
    print("no frontend files found")
    sys.exit(0)


def strip_strings(src: str) -> str:
    """
    Blank out strings and comments, in one pass.

    Doing it with sequential regexes cannot work, and the failure is not
    theoretical -- it happened. Strip strings first and an apostrophe in a
    comment ("somebody else's job") opens a string match that runs to the next
    quote anywhere in the file, blanking hundreds of lines and reporting every
    import as unused. Strip comments first and a "https://" inside a string
    eats the rest of that line.

    A single left-to-right walk that knows which state it is in has neither
    problem.
    """
    out: list[str] = []
    i, n = 0, len(src)
    while i < n:
        ch = src[i]

        if ch == "/" and i + 1 < n and src[i + 1] == "/":
            while i < n and src[i] != "\n":
                i += 1
            continue

        if ch == "/" and i + 1 < n and src[i + 1] == "*":
            end = src.find("*/", i + 2)
            i = n if end < 0 else end + 2
            continue

        if ch in "\"'`":
            quote = ch
            out.append(quote)
            i += 1
            while i < n:
                if src[i] == "\\":
                    i += 2
                    continue
                if src[i] == quote:
                    break
                # An unterminated single quote is almost always an apostrophe
                # in prose, not a string. Bail at the line end rather than
                # swallowing the rest of the file.
                if quote == "'" and src[i] == "\n":
                    break
                i += 1
            out.append(quote)
            i += 1
            continue

        out.append(ch)
        i += 1
    return "".join(out)


for page in pages:
    raw = page.read_text(encoding="utf-8")
    code = strip_strings(raw)
    rel = page.relative_to(ROOT / "web")

    # --- orphaned imports -------------------------------------------------
    for m in re.finditer(r"import\s*\{([^}]+)\}\s*from", raw):
        # `type Foo` is one symbol, not two. Splitting on the comma and taking
        # the whole fragment gave a symbol called "type Session", which is never
        # used because nothing is called that.
        for sym in (x.strip().removeprefix("type ").strip().split(" as ")[-1]
                    for x in m.group(1).split(",")):
            if not sym:
                continue
            # `code` has had backtick strings blanked, so a name used only
            # inside a template literal -- ${GeistMono.variable} -- vanishes
            # and reads as unused. Search the interpolations too.
            interpolated = " ".join(re.findall(r"\$\{([^}]*)\}", raw))
            uses = len(re.findall(rf"\b{re.escape(sym)}\b", code + " " + interpolated))
            if uses <= 1:
                problems.append(f"{rel}: imports '{sym}' and never uses it")

    # --- state that is written and never read -----------------------------
    for m in re.finditer(r"const \[(\w+), (set\w+)\] = useState", code):
        name, setter = m.group(1), m.group(2)
        reads = len(re.findall(rf"\b{name}\b", code)) - 1
        writes = len(re.findall(rf"\b{setter}\b", code)) - 1
        if reads == 0 and writes > 0:
            problems.append(
                f"{rel}: '{name}' is set {writes} time(s) and never read - "
                f"whatever displayed it is gone")


    # An "identifier used but never declared" rule lived here and has been
    # removed.
    #
    # It caught two real crashes when there was no compiler for these files.
    # There is one now, wired into verify.sh, and TS2304 does the job properly:
    # it understands scope, imports and JSX, none of which a regex does. Mine
    # reported the letters inside `vectorEffect`, then a sentence containing
    # the word "error", and then stopped catching what it was written for.
    #
    # A check that duplicates a compiler badly is worse than no check.

    # The JSX tag-balance rule has been retired.
    #
    # It was written when there was no compiler for these files, and it caught
    # two real breaks. There is a compiler now: an unbalanced tag is a parse
    # error tsc reports in a second, with the line and column.
    #
    # Left in place it reported balanced files as broken -- the adopted
    # codebase nests tags inside ternaries and map callbacks in ways a line
    # counter cannot follow, and a check that cries wolf on correct code is
    # worse than no check.

    # --- wide tables must be able to scroll --------------------------------
    #
    # This runs on cheap tablets in a forecourt office. An eight-column table
    # on a 768px screen either squashes columns until figures wrap mid-number,
    # or runs off the edge with nothing to say so -- and a supervisor reading a
    # variance column that is off-screen decides on the columns they can see.
    for m in re.finditer(r'<table className="table-premium', raw):
        seg = raw[m.start(): m.start() + 1600]
        head = seg[: seg.find("</thead>")] if "</thead>" in seg else seg[:700]
        cols = len(re.findall(r"<th", head))
        before = raw[max(0, m.start() - 260): m.start()]
        if cols >= 5 and "table-scroll" not in before and "overflow-x" not in before:
            line = raw[: m.start()].count("\n") + 1
            problems.append(
                f"{rel}:{line}: a {cols}-column table with no scroll wrapper - "
                f"columns will be unreachable on a tablet")


    # --- writes that a retry would duplicate -------------------------------
    #
    # On a forecourt tether a retry is normal, not exceptional. A write to a
    # table with no natural unique key duplicates silently on the second
    # attempt -- and a duplicated credit_payment or shortage_recovery is money
    # credited twice to somebody's account.
    #
    # WHICH key matters as much as whether there is one. A key DERIVED FROM
    # CONTENT cannot tell a retry from a second, genuine, identical sale: two
    # trucks from one fleet taking 100 L each, and the server replayed the
    # first -- "recorded" on screen, an attendant short at close. A RANDOM key
    # per attempt protects nothing. The right unit is the save: `submission`,
    # one key kept across retries and retired when the server confirms.
    #
    # So a save that can legitimately repeat must use `submission`. Content
    # keys stay right only where the write has a real identity -- an invoice
    # number, a delivery note, a code -- and those endpoints are not listed.
    REPEATABLE = ("/api/credit/payments", "/api/credit/shifts/", "/discounts",
                  "/api/dry-stock/shifts/", "/api/dry-stock/adjust", "/api/accounts/expenses",
                  "/api/ops/shortages/recover", "/api/accounts/supplier-payments",
                  "/api/v1/income", "/pump-tests", "/own-use", "/api/forecourt/dips",
                  "/rtt", "/api/ops/banking", "/api/dry-stock/receive")
    for m in re.finditer(r"api\s*\.\s*post<[^>]*>\([^;]{0,900}?\);", raw, re.S):
        call = m.group(0)
        head = call[:160]
        if not any(r in head for r in REPEATABLE):
            continue
        if re.search(r"/(approve|resolve|post|close)\b", head):
            continue          # a state change on one record: refused the second time
        line = raw[: m.start()].count("\n") + 1
        if "submission:" in call:
            continue
        if "idempotencyKey" in call:
            problems.append(
                f"{rel}:{line}: a repeatable save keyed on its CONTENT - a second, "
                f"identical transaction is replayed as a retry and silently dropped; "
                f"use `submission`")
        else:
            problems.append(
                f"{rel}:{line}: a repeatable save with no key - a retry records it twice")

    for m in re.finditer(r"api\.post\([^;]{0,400}?idempotencyKey:\s*crypto\.randomUUID", raw, re.S):
        line = raw[: m.start()].count("\n") + 1
        problems.append(
            f"{rel}:{line}: idempotency key is a fresh random uuid, so it "
            f"changes on every retry and prevents nothing")


    # --- removable rows keyed by array index -------------------------------
    #
    # React tells rows apart by their key. Keyed on the array index, removing
    # the second row makes React reuse that DOM node for the third -- and any
    # input inside it KEEPS THE REMOVED ROW'S VALUE against a different item.
    #
    # The operator sees a quantity they did not type against a product they did
    # not choose, and there is no error. On a sales screen that is the worst
    # kind of bug: silent, plausible, and wrong.
    #
    # Read-only rows are fine on an index and are not flagged.
    for m in re.finditer(r"\.map\(\((\w+), (\w+)\) =>", code):
        idx = m.group(2)
        # The row's own key is the FIRST key= after the map opens. Truncating
        # the window at a nested .map( cut it off before the key was reached --
        # a row containing a <select> of items has a nested map inside it, so
        # the check silently never fired on the one file it was written for.
        window = code[m.end(): m.end() + 2500]
        first_key = re.search(r"key=\{([^}]*)\}", window)
        if not first_key or first_key.group(1).strip() != idx:
            continue
        seg = window
        if ("<input" in seg or "<select" in seg) and (f"!== {idx}" in seg or "splice" in seg):
            line = code[: m.start()].count("\n") + 1
            problems.append(
                f"{rel}:{line}: rows carry inputs and can be removed, but are "
                f"keyed by array index - removing one leaves its value in the "
                f"next row")

    # --- success announced, nothing saved
    #
    # Twenty-five handlers changed the screen and toasted "Pump deleted",
    # "User removed", "Payment recorded" without ever calling the server. The
    # change vanished on reload; the person believed it had happened. One of
    # them recorded credit payments and moved the customer's balance. A
    # handler that says 'success' must reach the API, save a file, or print.
    # Read from RAW: the word it looks for lives inside a string literal.
    for hm in re.finditer(r"const (\w+) = (?:useCallback\()?(?:async )?\([^)]*\) => \{", raw):
        st = hm.end() - 1
        depth, k = 0, st
        while k < len(raw):
            if raw[k] == "{":
                depth += 1
            elif raw[k] == "}":
                depth -= 1
                if depth == 0:
                    break
            k += 1
        hbody = raw[st:k]
        if re.search(r"showToast\([^)]*'success'", hbody) and not re.search(
                r"api\s*\.\s*(post|put|del|get)|reload|setActive\(|window\.print|"
                r"download|exportTo|jsPDF|Blob|toCsv|\.csv", hbody):
            problems.append(
                f"{rel}: {hm.group(1)}() announces success but reaches no server "
                f"- the change disappears on reload")

    # --- today, in UTC
    #
    # new Date().toISOString() is UTC. In Kampala (UTC+3) it named yesterday
    # from midnight to 03:00 -- and a business day starts at 06:00, so from 03:00
    # to 06:00 it was wrong the other way. 26 places dated records and defaults
    # this way. Use businessToday() or localDate() from '@/lib/dates'.
    _nocomments = re.sub(r"//[^\n]*", "", re.sub(r"/\*.*?\*/", "", raw, flags=re.S))
    if not str(rel).endswith("lib/dates.ts"):
        for dm in re.finditer(r"new Date\(\)\.toISOString\(\)\.(?:slice|split|substring)\(", _nocomments):
            problems.append(f"{rel}: today taken in UTC - wrong from midnight to 06:00 in Kampala; "
                            f"use businessToday() or localDate()")

    # --- a load that restarts itself
    #
    # Depot and Management Reports set their DEFAULT depot, tank or site from
    # inside load(), and load() depended on that same state -- so choosing the
    # default rebuilt load, the effect saw a new load, and everything was
    # fetched a second time on every open. Harmless in a click handler;
    # doubled traffic when the function is also an effect's dependency.
    _states = dict(re.findall(r"const \[(\w+), (set\w+)\] = useState", raw))
    _by_setter = {v: k for k, v in _states.items()}
    _effect_deps = set()
    for em in re.finditer(r"useEffect\([\s\S]*?\},\s*\[([^\]]*)\]\s*\)", raw):
        _effect_deps |= {x.strip() for x in em.group(1).split(",") if x.strip()}
    for cm in re.finditer(r"const (\w+) = useCallback\(", raw):
        if cm.group(1) not in _effect_deps:
            continue
        st = raw.index("{", cm.end())
        depth, k = 0, st
        while k < len(raw):
            if raw[k] == "{":
                depth += 1
            elif raw[k] == "}":
                depth -= 1
                if depth == 0:
                    break
            k += 1
        dm = re.match(r"\s*,\s*\[([^\]]*)\]", raw[k + 1:])
        if not dm:
            continue
        cdeps = {x.strip() for x in dm.group(1).split(",") if x.strip()}
        own = sorted({_by_setter[x] for x in re.findall(r"\b(set\w+)\(", raw[st:k])
                      if x in _by_setter and _by_setter[x] in cdeps})
        if own:
            problems.append(
                f"{rel}: {cm.group(1)}() sets {', '.join(own)}, which it depends on, and an "
                f"effect depends on {cm.group(1)} - every open loads twice")

    # --- invented data
    #
    # An earlier sweep looked only for TYPED arrays (`const X: T[] = [`) and
    # large numeric state defaults, and declared the frontend clean. It was
    # not. Untyped `const data = [` carried dashboard revenue for five towns
    # in Essex, in pounds; a shared constant listed five stations this company
    # does not own, in twelve screens; the sidebar named a template person; a
    # report exported invented pump uptime. These are the shapes that got past.
    _mock = [
        (r"=\s*\[\s*\{\s*(grade|date|litres|amount|revenue|sales|pump|openingStock)\s*:",
         "an array of invented records"),
        (r"'(Kampala Central|Nairobi West|Dar es Salaam|Juba North|Mombasa Road|Harlow|Basildon|Chelmsford)",
         "a site that does not exist"),
        # Inside the quotes, not only whole: "James Okoro (ATT-001)" is a
        # template person too, and the whole-string pattern missed it.
        (r"'(Sarah Whitfield|James Okoro|Mary Achieng|Peter Waweru)[^']*'", "a person from the template"),
        # Case-insensitive: 'site-manager-harlow' sat in the user type unseen.
        (r"(?i)harlow|basildon|chelmsford|romford|grays gateway", "a town from the template"),
        (r"'[a-z.]+@forecourt-ops\.co\.uk'", "a template email address"),
        (r"useState\('20[0-9]{2}-[0-9]{2}-[0-9]{2}'\)", "a fixed date as a default"),
        (r"\u00a3|&pound;", "pounds sterling in a shilling business"),
    ]
    # From RAW, not `code`. `code` has its string literals blanked, and every
    # one of these patterns lives inside a string -- the first version of
    # this rule scanned text with the evidence removed, and caught one pound
    # sign out of a dozen purely because a template literal survived.
    _plain = re.sub(r"/\*.*?\*/", "", raw, flags=re.S)
    _plain = re.sub(r"(?<![:'\"])//[^\n]*", "", _plain)
    for pat, why in _mock:
        for mm in re.finditer(pat, _plain):
            problems.append(f"{rel}: {why} - {mm.group(0)[:40]!r}")

    # --- data a hook fetched, that nothing ever reads
    #
    # Four screens destructured `rows: liveRows` from useStatement and then
    # rendered their own state, which nothing filled. The fetch happened, the
    # data arrived, and the table stayed empty with no error anywhere. The
    # compiler's unused-variable check is off to match the adopted codebase,
    # so this is the only thing that sees it.
    # Counted with comments removed: a comment that MENTIONS the variable is
    # not a read of it. The first version of this rule counted the comment
    # explaining the fix, and so passed the exact bug it was written for.
    uncommented = re.sub(r"/\*.*?\*/", "", code, flags=re.S)
    uncommented = re.sub(r"//[^\n]*", "", uncommented)
    for hm in re.finditer(r"rows:\s*(\w+)\s*[,}]", uncommented):
        name = hm.group(1)
        if len(re.findall(rf"\b{re.escape(name)}\b", uncommented)) <= 1:
            problems.append(
                f"{rel}: `{name}` is fetched by a hook and never read - the screen "
                f"renders something else, so the data it loads never appears")

    # --- a screen that fetches should say it is fetching ------------------
    if "page.tsx" in page.name and "useEffect" in code and "api.get" in raw:
        if not re.search(r"\b(loading|busy|pending)\b", code, re.I):
            notes.append(
                f"{rel}: fetches on mount with no loading state - the screen is "
                f"blank until the network answers")

    # --- inputs need labels ----------------------------------------------
    #
    # The tag cannot be matched with [^>]* -- an arrow function in onChange
    # contains a ">" and the match stops there, before any aria-label further
    # down the tag. Scan forward to the real close instead, tracking braces.
    def input_tags(text: str):
        i = 0
        while True:
            i = text.find("<input", i)
            if i < 0:
                return
            depth, j = 0, i
            while j < len(text):
                ch = text[j]
                if ch == "{":
                    depth += 1
                elif ch == "}":
                    depth -= 1
                elif ch == ">" and depth == 0 and text[j - 1] in "/ \n\t\"'":
                    break
                j += 1
            yield i, text[i: j + 1]
            i = j + 1

    for start, tag in input_tags(raw):
        if re.search(r'type="(?:checkbox|radio|hidden)"', tag):
            continue
        if "aria-label" in tag or "placeholder" in tag:
            continue
        # A wrapping <label> counts. Find the nearest opening and closing tag
        # before this input: if the opening one is nearer, we are inside it.
        before = raw[:start]
        open_at = before.rfind("<label")
        close_at = before.rfind("</label>")
        if open_at > close_at:
            continue
        notes.append(f"{rel}: an input has no label, placeholder or aria-label")

print("=" * 70)
print("FCMS FRONTEND HYGIENE")
print("=" * 70)
print(f"files {len(pages)}")
print()

if problems:
    print(f"PROBLEMS ({len(problems)})")
    for p in sorted(set(problems)):
        print(f"  X {p}")
else:
    print("PROBLEMS  none")

if notes:
    print()
    print(f"NOTES ({len(set(notes))})")
    for n in sorted(set(notes))[:12]:
        print(f"  * {n}")

sys.exit(1 if problems else 0)
