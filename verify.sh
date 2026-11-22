#!/usr/bin/env bash
# Everything that can be verified without a database or a network.
# Run before every commit. Two of the bugs these caught would have failed on
# first run: a migration referencing a table created three files later, and a
# C# file mixing a file-scoped and a block namespace.
set -uo pipefail
cd "$(dirname "$0")"
fail=0

echo "-- scaffolding --"; python3 tools/check_scaffolding.py || fail=1
echo "-- schema --";   python3 tools/check_schema.py   || fail=1
echo "-- deep --";     python3 tools/check_deep.py     || fail=1
echo "-- api --";      python3 tools/check_api.py      || fail=1
echo "-- sql --";       python3 tools/check_sql.py       || fail=1
echo "-- seed --";      python3 tools/check_seed.py      || fail=1
echo "-- wiring --";    python3 tools/check_wiring.py    || fail=1
echo "-- roles --";     python3 tools/check_roles.py     || fail=1
echo "-- db rules --";  python3 tools/check_db_rules.py  || fail=1
echo "-- sql params --"; python3 tools/check_dapper_params.py || fail=1
echo "-- fn index --";   python3 tools/gen_function_index.py --check || fail=1
echo "-- arity --";     python3 tools/check_arity.py     || fail=1
echo "-- seams --";    python3 tools/check_seams.py    || fail=1
echo "-- contract --"; python3 tools/check_contract.py || fail=1
echo "-- coverage --"; python3 tools/check_coverage.py || fail=1

echo "-- arithmetic --"; python3 tools/check_arithmetic.py || fail=1
echo "-- types --";    python3 tools/check_types.py     || fail=1
echo "-- frontend --"; python3 tools/check_frontend.py || fail=1
echo "-- tsx syntax --"
# The compiler, run without dependencies. It cannot resolve imports or React
# types, so those error classes are filtered -- but it parses every file, and
# it catches what no amount of regex will: a malformed function, an undeclared
# name, a brace in the wrong place.
# The offline compile is now ADVISORY, not a gate.
#
# It was a gate when the frontend was hand-written with no framework imports:
# ambient declarations covered React, and everything else was ours. The adopted
# frontend is a full Next.js app -- next/image, next/dynamic, recharts, geist --
# and a shim cannot model a dynamic import returning a module namespace.
#
# The remaining errors are the shim's limits, not the code's. Reporting them as
# failures would train whoever runs this to ignore the output, so they are
# printed and counted instead. The real check is `npm install && npx tsc
# --noEmit` on a machine that can resolve the packages.
if command -v tsc >/dev/null 2>&1; then
  syn=$(cd web && tsc -p tsconfig.syntax.json 2>&1 \
        | grep -E "error TS(1[0-9]{3}|2304|2552|2451|7027|2367):" || true)
  if [ -n "$syn" ]; then
    echo "$syn" | head -20
    echo "  PROBLEMS  the compiler rejects these"
    fail=1
  else
    echo "  PROBLEMS  none -- every .tsx parses and every name resolves"
  fi
else
  echo "  skipped -- tsc not installed"
fi

echo "-- web (compiler) --"
# The real TypeScript compiler, over every screen -- not a regex approximating
# one. This found nine bugs in its first run that eight static checkers had
# missed, including a null dereference on the close screen and a field left
# reading a property that a rename had removed.
#
# web/offline-types/ambient.d.ts stands in for React and Next, which cannot be installed
# here. It checks OUR types strictly and approximates the libraries.
if command -v tsc >/dev/null 2>&1; then
  ( cd web && tsc -p tsconfig.check.json 2>&1 \
      | grep -v "TS7006\|TS2875" > /tmp/tsc.out || true
    # THE SHIM'S CODES, AND NOTHING ELSE, ARE TOLERATED.
    #
    # This step was made fully advisory because the offline shim cannot model
    # next/dynamic and friends. That was a mistake: it also waved through
    # "Cannot find name 'loading'" in the Reports screen -- a ReferenceError on
    # render -- and a GRADE_COLOUR deleted by a bad edit, while printing
    # "All static checks passed".
    #
    # The shim produces a small, known set of codes. Anything outside it is a
    # real error in real code and fails the build:
    #   TS2307  module not resolvable offline (next, geist, recharts)
    #   TS7006  untyped callback params from modules declared as any
    #   TS2604  next/dynamic returning a namespace the shim cannot type
    #   TS2591  `process` without @types/node
    #   TS2694  React.ComponentType absent from the shim
    #   TS18046 React typed as unknown in the shim
    #   TS2339  ONLY for `displayName`. A missing property is otherwise the
    #           most valuable error there is -- it is what reading a shift
    #           summary as a shift detail produces.
    grep -vE "TS2307|TS7006|TS2604|TS2591|TS2694|TS18046" /tmp/tsc.out \
      | grep -vE "TS2339.*displayName" \
      | grep "error TS" > /tmp/tsc.real || true
    shim=$(grep -cE "error TS" /tmp/tsc.out || true)
    real=$(grep -c "error TS" /tmp/tsc.real || true)
    if [ "$real" -gt 0 ]; then
      echo "  PROBLEMS ($real real, $((shim - real)) shim)"
      sed "s/^/    X /" /tmp/tsc.real
      exit 1
    fi
    echo "  PROBLEMS  none -- $shim shim-only (run npm install && npx tsc --noEmit for the rest)"
    exit 0
  ) || fail=1
else
  echo "  tsc not found -- screens NOT compiled"
fi
echo
[ $fail -eq 0 ] && echo "All static checks passed." || echo "FAILED."
exit $fail
