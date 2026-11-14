"""Bounded ignored-aware filename and literal content search."""
import json
import selectors
import re
import subprocess
import time
from storage import resolve, locked, read_json, write_json


def lines(args, root, limit, byte_limit=2 * 1024 * 1024, cancelled=lambda: False):
    process = subprocess.Popen(['rg', *args], cwd=root, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    output, size, incomplete = [], 0, False
    selector = selectors.DefaultSelector()
    selector.register(process.stdout, selectors.EVENT_READ)
    started, pending = time.monotonic(), b''
    try:
        while selector.get_map():
            if cancelled() or time.monotonic() - started > 4:
                incomplete = True
                break
            if not selector.select(.1):
                continue
            block = process.stdout.read1(65536)
            if not block:
                break
            size += len(block)
            if size > byte_limit:
                incomplete = True
                break
            pending += block
            while b'\n' in pending:
                line, pending = pending.split(b'\n', 1)
                output.append(line.decode('utf-8', 'replace'))
                if len(output) >= limit:
                    incomplete = True
                    break
            if incomplete:
                break
    finally:
        selector.close()
        if process.poll() is None:
            process.terminate()
        process.wait(timeout=2)
        process.stdout.close()
    return output, incomplete


def fuzzy(query, name):
    query, name = query.casefold(), name.casefold()
    cursor, score, previous = 0, 0, -2
    for char in query:
        at = name.find(char, cursor)
        if at < 0:
            return None
        score += 12 if at == previous + 1 else 1
        score += 6 if at == 0 or name[at - 1] in '/._-' else 0
        previous, cursor = at, at + 1
    return score - len(name) / 1000


def generation(request, home):
    client = request.get("client", "default")
    if not re.fullmatch(r"[a-zA-Z0-9_-]{1,80}", client): raise ValueError("Invalid search client")
    path = home / "search" / (client + ".json")
    sequence = request.get("sequence", 0)
    if type(sequence) is not int or sequence < 0: raise ValueError("Invalid search sequence")
    with locked(home):
        current = read_json(path, 0)
        if sequence >= current: write_json(path, sequence)
    return path, sequence


def search(request, home):
    path, sequence = generation(request, home)
    cancelled = lambda: read_json(path, 0) > sequence
    root, _ = resolve({**request, 'path': ''}, allow_root=True)
    query = request.get('query', '')
    if not isinstance(query, str) or len(query) > 1000:
        raise ValueError('Search text must be under 1,000 characters')
    base = ['--hidden', '--glob', '!.git', '--glob', '!**/.git/**']
    if request.get('mode') == 'files':
        names, incomplete = lines(['--files', *base], root, 50000, cancelled=cancelled)
        ranked = [(fuzzy(query, name), name) for name in names]
        ranked = sorted(((-score, name) for score, name in ranked if score is not None))[:100]
        return {'items': [{'path': name} for _, name in ranked], 'incomplete': incomplete}
    if not query:
        return {'items': [], 'incomplete': False}
    raw, incomplete = lines(['--json', '--fixed-strings', '--case-sensitive' if request.get('matchCase') else '--ignore-case', *base, '--', query, '.'], root, 5000, cancelled=cancelled)
    items = []
    for line in raw:
        item = json.loads(line)
        if item.get('type') != 'match':
            continue
        data = item['data']
        if 'text' not in data['path'] or 'text' not in data['lines']:
            continue
        items.append({'path': data['path']['text'].removeprefix('./'), 'line': data['line_number'], 'text': data['lines']['text'].rstrip('\r\n')[:2000],
                      'column': len(data['lines']['text'].encode()[:data['submatches'][0]['start']].decode('utf-8', 'replace')) + 1})
        if len(items) >= 1000:
            incomplete = True
            break
    return {'items': items, 'incomplete': incomplete}
