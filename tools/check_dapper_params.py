"""
check_dapper_params -- every @parameter a SQL statement uses is one the C# passes.

A missing one is not a compile error: it fails at runtime ("parameter must be
declared"), and only when that screen is used. Comments inside the parameter
object, and C# verbatim names (@in = ...), are understood.
"""
import re, pathlib, sys
ROOT = (pathlib.Path(sys.argv[1]) if len(sys.argv) > 1 else pathlib.Path(__file__).resolve().parents[1] / 'api') if __name__ == '__main__' else None
def balanced(s, i, open_='(', close=')'):
    depth = 0; j = i; q = None
    while j < len(s):
        c = s[j]
        if s.startswith('"""', j):
            k = s.index('"""', j + 3); j = k + 3; continue
        if c == '"' and not q:
            k = j + 1
            while k < len(s) and not (s[k] == '"' and s[k-1] != '\\'): k += 1
            j = k + 1; continue
        if c == open_: depth += 1
        elif c == close:
            depth -= 1
            if depth == 0: return j
        j += 1
    return -1
def top_args(s):
    out, depth, cur, j = [], 0, '', 0
    while j < len(s):
        if s.startswith('"""', j):
            k = s.index('"""', j + 3); cur += s[j:k+3]; j = k + 3; continue
        c = s[j]
        if c == '"':
            k = j + 1
            while k < len(s) and not (s[k] == '"' and s[k-1] != '\\'): k += 1
            cur += s[j:k+1]; j = k + 1; continue
        if c in '([{': depth += 1
        if c in ')]}': depth -= 1
        if c == ',' and depth == 0: out.append(cur.strip()); cur = ''
        else: cur += c
        j += 1
    if cur.strip(): out.append(cur.strip())
    return out
def sql_of(expr):
    parts = re.findall(r'"""(.*?)"""', expr, re.S)
    if parts: return "\n".join(parts)
    parts = re.findall(r'"((?:[^"\\]|\\.)*)"', expr)
    return "".join(parts) if parts else None
def main():
    issues = 0; checked = 0; skipped = 0
    for f in sorted(ROOT.rglob('*.cs')):
        if 'bin' in f.parts or 'obj' in f.parts: continue
        s = f.read_text(encoding='utf-8')
        for m in re.finditer(r'new CommandDefinition\(', s):
            end = balanced(s, m.end() - 1)
            args = top_args(s[m.end():end])
            if len(args) < 2 or args[1].startswith(('transaction', 'cancellationToken', 'commandType')):
                sqltxt = sql_of(args[0]) if args else None
                if sqltxt and re.search(r"(?<![@\w:])@(\w+)", re.sub(r"'[^']*'", "", sqltxt)):
                    issues += 1
                    print(f"  X {f.relative_to(ROOT)}:{s[:m.start()].count(chr(10))+1}  SQL uses parameters but none are passed")
                continue
            sqltxt = sql_of(args[0])
            if sqltxt is None or re.search(r'\$"|\$\$"""', args[0]): skipped += 1; continue
            p = args[1]
            if not p.startswith('new'): skipped += 1; continue     # a variable / DynamicParameters
            body = p[p.index('{') + 1:p.rindex('}')] if '{' in p else ''
            body = re.sub(r"//[^\n]*", "", body)          # comments may hold commas
            given = set()
            for a in top_args(body):
                a = a.strip()
                if not a: continue
                mm = re.match(r"@?(\w+)\s*=", a)      # @in = ... : a C# verbatim name
                if mm: given.add(mm.group(1).lower())
                else: given.add(re.split(r"[.?]", a)[-1].strip().lower())
            clean = re.sub(r"'(?:[^']|'')*'", "''", sqltxt)
            clean = re.sub(r"--[^\n]*", "", clean)
            used = {u.lower() for u in re.findall(r"(?<![@\w:])@(\w+)", clean)}
            checked += 1
            missing = sorted(used - given)
            if missing:
                issues += 1
                print(f"  X {f.relative_to(ROOT)}:{s[:m.start()].count(chr(10))+1}  SQL needs @{', @'.join(missing)} - not passed")
    print(f"commands checked: {checked} | skipped (variable params): {skipped} | missing parameters: {issues}")
    sys.exit(1 if issues else 0)

if __name__ == '__main__':
    main()
