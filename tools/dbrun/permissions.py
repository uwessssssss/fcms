#!/usr/bin/env python3
"""
The API's copy of the permissions against the database's.

    python3 tools/dbrun/permissions.py DB            # check: exit 1 on any difference
    python3 tools/dbrun/permissions.py DB --write    # rewrite the C# map from the database

api/Infrastructure/CurrentUser.cs keeps RolePermissions, a copy of the
role_permission table, so a request does not ask the database what a role
may do. Its comment said "the integrity suite asserts the two agree". Nothing
did. HEAD_OFFICE (added to the database in 230/290) was never added to the
copy, so the API refused head office almost everything -- found by the first
full-stack run, November 2026. This is that check.

SYSTEM_ADMIN is a wildcard in the API (it may do anything) and is left out.
"""
import re
import subprocess
import sys

CS = 'api/Infrastructure/CurrentUser.cs'
START = 'private static readonly Dictionary<string, HashSet<string>> Map = new(StringComparer.OrdinalIgnoreCase)\n    {\n'
END = '\n    };\n'


def db_map(db):
    out = subprocess.run(['psql', '-d', db, '-X', '-At', '-F', '|', '-c',
                          "SELECT role, permission FROM role_permission WHERE role <> 'SYSTEM_ADMIN' ORDER BY 1, 2"],
                         capture_output=True, text=True, check=True).stdout
    m = {}
    for line in out.strip().splitlines():
        r, p = line.split('|')
        m.setdefault(r, []).append(p)
    return m


def cs_block(src):
    i = src.index(START) + len(START)
    j = src.index(END, i)
    return i, j


def cs_map(src):
    i, j = cs_block(src)
    m = {}
    for e in re.finditer(r'\["([A-Z_]+)"\]\s*=\s*new\(StringComparer\.OrdinalIgnoreCase\)\s*\{([^}]*)\}', src[i:j]):
        m[e.group(1)] = sorted(set(re.findall(r'"([a-z_.]+)"', e.group(2))))
    return m


def render(m):
    parts = []
    for role in sorted(m):
        perms = sorted(m[role])
        lines, line = [], '            '
        for p in perms:
            item = f'"{p}", '
            if len(line) + len(item) > 96:
                lines.append(line.rstrip())
                line = '            '
            line += item
        lines.append(line.rstrip().rstrip(','))
        parts.append(f'        ["{role}"] = new(StringComparer.OrdinalIgnoreCase)\n        {{\n' + '\n'.join(lines) + '\n        },')
    return '        // Generated from role_permission by tools/dbrun/permissions.py --write;\n' \
           '        // CI fails if the two differ.\n' + '\n'.join(parts)


def main():
    db = sys.argv[1] if len(sys.argv) > 1 else 'fcms'
    src = open(CS).read()
    want = db_map(db)
    if '--write' in sys.argv:
        i, j = cs_block(src)
        open(CS, 'w').write(src[:i] + render(want) + src[j:])
        print(f'wrote {len(want)} roles to {CS}')
        return 0
    have = cs_map(src)
    bad = 0
    for role in sorted(set(want) | set(have)):
        a, b = set(have.get(role, [])), set(want.get(role, []))
        if a != b:
            bad += 1
            print(f'  X {role}: only in the API {sorted(a - b)}; only in the database {sorted(b - a)}')
    if bad:
        print(f'{bad} role(s) differ between {CS} and role_permission. '
              'Run: python3 tools/dbrun/permissions.py DB --write')
        return 1
    print(f'API permissions agree with the database: {len(want)} roles')
    return 0


if __name__ == '__main__':
    sys.exit(main())
