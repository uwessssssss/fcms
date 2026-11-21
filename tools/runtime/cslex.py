import pathlib, sys
def lex(s):
    """Returns (ok, message). Tracks () [] {} outside strings/comments."""
    i, n, stack = 0, len(s), []
    line = lambda k: s.count('\n', 0, k) + 1
    def raw(i, dollars):
        q = 0
        while i < n and s[i] == '"': q += 1; i += 1
        close = '"' * q
        while True:
            j = s.find(close, i)
            if j < 0: raise ValueError(f"unterminated raw string")
            if dollars:          # interpolation holes {{...}} for $$""", {...} for $"""
                seg = s[i:j]
            return j + q
    while i < n:
        c = s[i]
        if s.startswith('//', i): i = s.find('\n', i); i = n if i < 0 else i; continue
        if s.startswith('/*', i):
            j = s.find('*/', i + 2)
            if j < 0: return False, f"line {line(i)}: unterminated block comment"
            i = j + 2; continue
        # raw strings: """  $"""  $$"""
        k = i; d = 0
        while k < n and s[k] == '$': d += 1; k += 1
        if s.startswith('"""', k):
            try: i = raw(k, d); continue
            except ValueError as e: return False, f"line {line(i)}: {e}"
        if s.startswith('@"', i) or s.startswith('$@"', i) or s.startswith('@$"', i):
            j = s.index('"', i) + 1
            while True:
                if j >= n: return False, f"line {line(i)}: unterminated verbatim string"
                if s[j] == '"':
                    if j + 1 < n and s[j+1] == '"': j += 2; continue
                    break
                j += 1
            i = j + 1; continue
        if c == '"' or s.startswith('$"', i):
            interp = s[i] == '$'; j = i + (2 if interp else 1); depth = 0
            while True:
                if j >= n or s[j] == '\n': return False, f"line {line(i)}: unterminated string"
                ch = s[j]
                if ch == '\\': j += 2; continue
                if interp and ch == '{':
                    if s[j+1:j+2] == '{': j += 2; continue
                    depth += 1
                elif interp and ch == '}' and depth:
                    depth -= 1
                elif ch == '"' and depth == 0: break
                j += 1
            i = j + 1; continue
        if c == "'":
            j = i + 1
            if s[j:j+1] == '\\': j += 2
            else: j += 1
            if s[j:j+1] == "'": i = j + 1; continue
            i += 1; continue
        if c in '([{': stack.append((c, i))
        elif c in ')]}':
            if not stack: return False, f"line {line(i)}: '{c}' closes nothing"
            o, oi = stack.pop()
            if {'(': ')', '[': ']', '{': '}'}[o] != c:
                return False, f"line {line(i)}: '{c}' closes '{o}' opened on line {line(oi)}"
        i += 1
    if stack:
        o, oi = stack[-1]; return False, f"'{o}' opened on line {line(oi)} is never closed"
    return True, ""
bad = 0; files = [f for f in pathlib.Path(sys.argv[1]).rglob('*.cs') if 'bin' not in f.parts and 'obj' not in f.parts]
for f in files:
    ok, msg = lex(f.read_text(encoding='utf-8'))
    if not ok: bad += 1; print(f"  X {f.name}: {msg}")
print(f"C# files lexed: {len(files)}   structurally broken: {bad}")
