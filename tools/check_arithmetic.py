#!/usr/bin/env python3
"""
FCMS arithmetic consistency check.

Every other checker in this repo asks whether the code is well-formed. This one
asks whether it is RIGHT, for the small number of sums where being wrong is
expensive and silent.

It exists because two real errors got through all eight of the others:

  * Revenue is litres times the shift price, gross of any discount -- and the
    discount was never subtracted. Margin was overstated by every shilling
    given away, and the screen said out loud that it was already accounted for.

  * Own-use fuel reduces stock legitimately, so it is not a loss. But it was
    bought and never sold, and its cost was charged nowhere at all. A station
    running a generator through a power cut understated its costs by exactly
    that much.

Neither is a structural fault. Both compile, both typecheck, both pass every
seam and contract check, and both quietly flatter the numbers.

The rule this enforces is narrow and worth stating plainly: ANY PLACE THAT
COMPUTES A NET POSITION MUST SUBTRACT THE SAME THINGS. A figure that is net of
expenses on one screen and gross of discounts on another is a figure nobody can
quote in a meeting.
"""
import re
import sys
import pathlib

ROOT = pathlib.Path(__file__).parent.parent
API = ROOT / "api"

problems: list[str] = []
notes: list[str] = []

# Everything that must come off a net position, and the phrase that proves it.
# [\w.]* so an expression like `- spend.Expenses` matches. The first version
# used \w*, which stops at the dot, and reported three deductions as missing
# when they were right there.
DEDUCTIONS = {
    "expenses": r"-\s*[\w.]*[Ee]xpenses",
    "discounts": r"-\s*[\w.]*[Dd]iscounts",
    "own use": r"-\s*[\w.]*[Oo]wnUse",
    # Stock loss is already negative when fuel went missing, so it is ADDED.
    "stock loss": r"[+-]\s*[\w.]*[Ss]tockLoss",
}

# Files that produce a bottom-line figure a person will read as "profit".
NET_PRODUCERS = [
    ("AccountsService.cs", "the period statement"),
]

# ONE PRODUCER, ON PURPOSE. The trading-day summary used to compute its own
# net figure and was removed with its endpoint (superseded by the daily
# summary statement). The directors' pack shows a net position too, but it
# asks the period statement for it rather than computing one -- so there is
# exactly one profit formula in the system, which cannot disagree with itself.
# That only stays true while consumers DELEGATE, so each must keep doing so.
DELEGATES = [
    ("DirectorsService.cs", "_accounts.StatementAsync", "the directors' pack"),
]
for filename, call, what in DELEGATES:
    found = list(API.rglob(filename))
    if found and call not in found[0].read_text(encoding="utf-8"):
        problems.append(
            f"{what} ({filename}) no longer takes its net position from the period "
            f"statement - a second profit formula can now disagree with the first")

for filename, what in NET_PRODUCERS:
    matches = list(API.rglob(filename))
    if not matches:
        problems.append(f"{filename} not found - has it moved?")
        continue
    src = matches[0].read_text(encoding="utf-8")

    for label, pattern in DEDUCTIONS.items():
        if not re.search(pattern, src):
            problems.append(
                f"{filename} ({what}) computes a net position without "
                f"subtracting {label} - it will disagree with the other screens")

# Revenue must be consistently gross. If one query nets the discount at source
# and another does not, subtracting it later double-counts on one of them.
gross_revenue = re.compile(r"SUM\(\s*md\.litres\s*\*\s*md\.unit_price\s*\)")
netted_revenue = re.compile(r"SUM\([^)]*unit_price[^)]*-[^)]*discount", re.I)
for f in API.rglob("*.cs"):
    src = f.read_text(encoding="utf-8")
    if netted_revenue.search(src):
        problems.append(
            f"{f.name}: revenue appears to net a discount at source. Every other "
            f"query computes revenue gross and subtracts once at the bottom - "
            f"mixing the two double-counts on one of them")

# Wet stock reconciles by TANK, never by pump.
#
# A pump is a housing. Nozzles carry the tank, and nozzles on DIFFERENT pumps
# routinely draw from the SAME tank -- that is ordinary plumbing, not an edge
# case. Any query that totals throughput per pump therefore under-reports the
# moment one tank feeds two pumps, and it does so silently: the figure looks
# reasonable, it is just missing the other pump's litres.
for f in list(API.rglob("*.cs")) + list((ROOT / "db" / "migrations").glob("*.sql")):
    src = f.read_text(encoding="utf-8")
    # Resolve the alias from the JOIN rather than guessing at it. "p" is the
    # product table far more often than the pump table, and assuming otherwise
    # flagged two correct queries on the first run.
    for m in re.finditer(r"GROUP BY[^;)]{0,200}", src):
        clause = m.group(0)
        window = src[max(0, m.start() - 1400): m.start()]

        pump_aliases = set(re.findall(r"JOIN\s+pump\s+(\w+)", window, re.I))
        pump_aliases.add("__none__")   # so the pattern below is never empty
        alias_re = "|".join(re.escape(a) for a in pump_aliases)

        groups_by_pump = re.search(rf"\b(?:{alias_re})\.(?:id|code)\b|\bpump_id\b", clause)
        sums_litres = re.search(r"litres|throughput", window, re.I)
        if groups_by_pump and sums_litres:
            line = src[: m.start()].count("\n") + 1
            problems.append(
                f"{f.name}:{line}: totals litres grouped by pump. Nozzles on "
                f"different pumps share tanks, so this under-reports whenever "
                f"one tank feeds two pumps - group by tank")

# A UI claim that contradicts the arithmetic is worse than no claim.
WEB = ROOT / "web"
for page in WEB.rglob("*.tsx"):
    text = page.read_text(encoding="utf-8")
    if re.search(r"already (inside|included|accounted)", text, re.I):
        notes.append(
            f"{page.relative_to(WEB)} tells the reader a figure is 'already "
            f"included' - check that it actually is")

print("=" * 70)
print("ARITHMETIC CONSISTENCY")
print("=" * 70)
print(f"net-position producers checked: {len(NET_PRODUCERS)}")
print()

if problems:
    print(f"PROBLEMS ({len(problems)})")
    for p in problems:
        print("  X", p)
else:
    print("PROBLEMS  none -- every bottom line subtracts the same things")

if notes:
    print()
    print(f"NOTES ({len(notes)})")
    for n in notes:
        print("  *", n)

sys.exit(1 if problems else 0)
