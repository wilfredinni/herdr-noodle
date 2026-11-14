"""Snapshot-checked Git hunks and optional read-only GitHub information."""
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import time
import uuid
from storage import atomic, fingerprint, identity, read_json, resolve, write_json


def git(root, *args, data=None):
    r = subprocess.run(['git', '--no-optional-locks', '-c', 'core.fsmonitor=false', '--literal-pathspecs', *args], cwd=root, input=data, capture_output=True, timeout=20)
    if r.returncode: raise ValueError(r.stderr.decode('utf-8', 'replace').strip() or 'Git could not complete this operation')
    return r.stdout


def snapshot(root, path):
    index = Path(os.fsdecode(git(root, 'rev-parse', '--path-format=absolute', '--git-path', 'index')).strip())
    file = root / path
    if file.is_symlink(): raise ValueError('Hunk actions are unavailable for symbolic links')
    return {'head': git(root, 'rev-parse', 'HEAD').decode().strip(), 'branch': git(root, 'rev-parse', '--abbrev-ref', 'HEAD').decode().strip(),
            'index': hashlib.sha256(index.read_bytes() if index.exists() else b'').hexdigest(),
            'file': hashlib.sha256(file.read_bytes() if file.exists() else b'').hexdigest(), 'stat': fingerprint(file)}


def hunks(request, home):
    root, file = resolve(request)
    mode = request.get('mode', 'unstaged')
    if mode not in ['staged', 'unstaged']: raise ValueError('Choose staged or working-tree changes')
    before = snapshot(root, request['path'])
    patch = git(root, 'diff', '--no-ext-diff', '--no-renames', '--no-color', '--full-index', *(['--cached'] if mode == 'staged' else []), '--', request['path'])
    if snapshot(root, request['path']) != before: raise ValueError('The file changed while reading its hunks')
    if len(patch) > 1024 * 1024 or b'\0' in patch or b'Binary files ' in patch:
        raise ValueError('This patch is too large or binary; use whole-file actions')
    source = patch.decode('utf-8')
    starts = [m.start() for m in re.finditer(r'^@@ ', source, re.M)]
    header = source[:starts[0]] if starts else ''
    parts = [header + source[start:(starts[i + 1] if i + 1 < len(starts) else len(source))] for i, start in enumerate(starts)]
    token = uuid.uuid4().hex
    record = {'root': str(root), 'path': request['path'], 'mode': mode, 'snapshot': before, 'parts': parts}
    write_json(home / 'hunks' / (token + '.json'), record)
    for old in (home / 'hunks').glob('*.json'):
        if time.time() - old.stat().st_mtime > 86400: old.unlink()
    return {'token': token, 'mode': mode, 'hunks': [part[len(header):] for part in parts]}


def apply(request, home):
    token = request.get('token', '')
    if not re.fullmatch(r'[0-9a-f]{32}', token): raise ValueError('Invalid hunk identity')
    record = read_json(home / 'hunks' / (token + '.json'))
    if not record: raise ValueError('Reload the file hunks before trying again')
    root, file = resolve(record)
    action = request['operation']
    if action not in (['unstage'] if record['mode'] == 'staged' else ['stage', 'discard']): raise ValueError('This hunk action does not match the selected version')
    if snapshot(root, record['path']) != record['snapshot']: raise ValueError('HEAD, index or file changed. Reload these hunks before applying.')
    number = request.get('hunk')
    if type(number) is not int or not 0 <= number < len(record['parts']): raise ValueError('This hunk is unavailable')
    patch = record['parts'][number].encode()
    flags = ['--cached'] if action == 'stage' else ['--cached', '--reverse'] if action == 'unstage' else ['--reverse']
    git(root, 'apply', '--check', *flags, '-', data=patch)
    if action == 'discard':
        if request.get('confirmed') is not True: raise ValueError('Confirm discarding this hunk first')
        atomic(home / 'discarded' / (token + '.file'), file.read_bytes())
        write_json(home / 'discarded' / (token + '.json'), {'root': str(root), 'path': record['path'], 'time': time.time()})
    if snapshot(root, record['path']) != record['snapshot']: raise ValueError('The file changed again. Reload these hunks.')
    git(root, 'apply', *flags, '-', data=patch)
    (home / 'hunks' / (token + '.json')).unlink()
    return {'changed': True}


def compare(request):
    root, _ = resolve({**request, 'path': ''}, allow_root=True)
    ref = request.get('ref') or '@{upstream}'
    if len(ref) > 200 or ref.startswith('-') or '\0' in ref: raise ValueError('Choose a valid branch or ref')
    target = git(root, 'rev-parse', '--verify', ref + '^{commit}').decode().strip()
    head = git(root, 'rev-parse', 'HEAD').decode().strip()
    base = git(root, 'merge-base', head, target).decode().strip()
    raw = git(root, 'diff', '--name-status', '-z', '--no-renames', base, head).decode().split('\0')
    files = [{'status': raw[i], 'path': raw[i + 1]} for i in range(0, len(raw) - 1, 2)]
    return {'head': head, 'base': base, 'ref': ref, 'files': files[:1000], 'incomplete': len(files) > 1000}


def pr(request, home):
    root, _ = resolve({**request, 'path': ''}, allow_root=True)
    args = ['gh', 'pr', 'view', '--json', 'number,title,url,headRefOid,headRefName,baseRefName,reviewDecision,reviews,statusCheckRollup']
    result = subprocess.run(args, cwd=root, capture_output=True, text=True, timeout=25)
    if result.returncode: raise ValueError(result.stderr.strip() or 'Install and sign in to gh yourself to view PR checks')
    value = json.loads(result.stdout)
    value['localHead'] = git(root, 'rev-parse', 'HEAD').decode().strip()
    write_json(home / 'prs' / (identity(root) + '.json'), value)
    return value


def failure_log(request, home):
    root, _ = resolve({**request, 'path': ''}, allow_root=True)
    cached = read_json(home / 'prs' / (identity(root) + '.json'))
    run = str(request.get('run', ''))
    if not cached or not re.fullmatch(r'[0-9]{1,20}', run): raise ValueError('Reload the PR checks before reading logs')
    urls = [check.get('detailsUrl', '') for check in cached.get('statusCheckRollup', [])]
    if not any(re.search(r'/actions/runs/' + run + r'(?:/|$)', url) for url in urls): raise ValueError('This run is not part of the selected PR checks')
    result = subprocess.run(['gh', 'run', 'view', run, '--json', 'headSha'], cwd=root, capture_output=True, text=True, timeout=15)
    if result.returncode or json.loads(result.stdout).get('headSha') != cached['headRefOid']: raise ValueError('The workflow does not belong to the selected PR commit')
    import selectors
    process = subprocess.Popen(['gh', 'run', 'view', run, '--log-failed'], cwd=root, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    selector = selectors.DefaultSelector(); selector.register(process.stdout, selectors.EVENT_READ)
    started, tail, size = time.monotonic(), b'', 0
    try:
        while time.monotonic() - started < 25:
            if not selector.select(.1):
                if process.poll() is not None: break
                continue
            block = process.stdout.read1(65536)
            if not block: break
            size += len(block); tail = (tail + block)[-200000:]
        else: raise ValueError('Reading failure logs timed out; open the check link for the full log')
    finally:
        selector.close()
        if process.poll() is None: process.terminate()
        process.wait(timeout=2); process.stdout.close()
    if process.returncode: raise ValueError('GitHub could not provide failure logs for this run')
    return {'text': tail.decode('utf-8', 'replace'), 'truncated': size > 200000, 'head': cached['headRefOid']}
