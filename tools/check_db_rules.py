#!/usr/bin/env python3
"""
check_db_rules.py -- the code against the DATABASE'S OWN RULES.

The first real run failed on things no structural check saw, because they
only fail when PostgreSQL executes them: a trigger reading a field its table
lacks, a statement order that broke a constraint. A pass looking for that
class found two more that had stopped every depot day from opening. This runs
those checks, from a model of the schema built from the migrations in order:

  inserts  -- every INSERT supplies every required column
  arity    -- every call to a project SQL function has a valid argument count
  domains  -- every literal written or compared fits its column's allowed list
  coupled  -- no UPDATE sets a value whose rule needs another column, without it
  grants   -- every DELETE the app runs is one the app's role may run
"""
import subprocess, sys, pathlib
here = pathlib.Path(__file__).with_name("dbrules")
print("=" * 70); print("CODE AGAINST THE DATABASE'S RULES"); print("=" * 70)
subprocess.run([sys.executable, str(here / "schema.py")], check=True)
fail = 0
for step in ("inserts", "arity", "domains", "coupled", "grants"):
    r = subprocess.run([sys.executable, str(here / f"{step}.py")], capture_output=True, text=True)
    out = [l for l in r.stdout.splitlines() if l.startswith("  X") or l.startswith(("inserts", "calls", "columns", "updates", "deletes"))]
    print(f"-- {step}"); print("\n".join(out))
    fail |= r.returncode != 0
print("\nPROBLEMS  none" if not fail else "\nPROBLEMS  found")
sys.exit(1 if fail else 0)
