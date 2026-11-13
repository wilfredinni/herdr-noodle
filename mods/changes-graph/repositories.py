"""Bounded, read-only discovery for the Changes repository picker."""
import json
from collections import deque
import os
from pathlib import Path
import subprocess
import sys
import time

READ = ['git', '--no-optional-locks', '-c', 'core.fsmonitor=false', '-c', 'diff.autoRefreshIndex=false']
SKIP = {'.git', 'node_modules', 'vendor', 'target', 'dist', 'build', '.venv', 'venv', '__pycache__', '.next', '.cache'}


def discover(folder):
    deadline = time.monotonic() + 8
    roots, seen, warnings = [], set(), set()
    limited = False

    def git(path, *args):
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise subprocess.TimeoutExpired('git', 8)
        return subprocess.run(READ + list(args), cwd=path, capture_output=True,
                              timeout=min(2, remaining), encoding='utf-8', errors='replace')

    def add(path):
        top = git(path, 'rev-parse', '--show-toplevel')
        if top.returncode:
            warnings.add('Some repositories could not be read.')
            return
        root = top.stdout.rstrip('\r\n')
        if root not in seen:
            seen.add(root)
            roots.append(root)

    base = Path(folder).resolve()
    if not base.is_dir():
        raise ValueError('Workspace folder is unavailable.')
    # A workspace can be a subdirectory of a repository.
    top = git(base, 'rev-parse', '--show-toplevel')
    if top.returncode == 0:
        root = top.stdout.rstrip('\r\n')
        seen.add(root)
        roots.append(root)
    queue = deque([(base, 0)])
    visited = 0
    try:
        while queue:
            path, depth = queue.popleft()
            visited += 1
            if visited > 2000 or len(roots) >= 64 or time.monotonic() >= deadline:
                limited = True
                break
            if (path / '.git').exists():
                add(path)
            try:
                with os.scandir(path) as entries:
                    for index, entry in enumerate(entries):
                        if index >= 2000:
                            limited = True
                            break
                        if entry.name in SKIP or not entry.is_dir(follow_symlinks=False):
                            continue
                        if depth < 4 and len(queue) + visited < 2000:
                            queue.append((Path(entry.path), depth + 1))
                        else:
                            limited = True
            except OSError:
                warnings.add('Some folders could not be read.')
    except subprocess.TimeoutExpired:
        limited = True

    repos = []
    for root in roots:
        row = {'root': root, 'name': os.path.relpath(root, base) if root != str(base) else base.name,
               'branch': None, 'count': None, 'ahead': 0, 'behind': 0, 'conflict': False, 'worktree': False}
        if row['name'].startswith('..'):
            row['name'] = Path(root).name
        try:
            row['worktree'] = (Path(root) / '.git').is_file()
            status = git(root, 'status', '--porcelain=v2', '-z', '--branch', '--untracked-files=all', '--no-renames')
            if status.returncode:
                row['error'] = 'Cannot read repository status'
            else:
                count = 0
                for entry in status.stdout.split('\0'):
                    if entry.startswith('# branch.head '):
                        row['branch'] = entry[14:]
                    elif entry.startswith('# branch.ab '):
                        ahead, behind = entry[12:].split()
                        row['ahead'], row['behind'] = int(ahead), abs(int(behind))
                    elif entry.startswith(('1 ', '2 ', 'u ', '? ')):
                        count += 1
                        row['conflict'] |= entry.startswith('u ')
                row['count'] = count
        except (OSError, subprocess.TimeoutExpired):
            row['error'] = 'Status unavailable; refresh to retry'
            limited = time.monotonic() >= deadline or limited
        repos.append(row)
    return {'repositories': sorted(repos, key=lambda r: (r['root'] != str(base), r['name'].casefold())),
            'limited': limited, 'warning': ' '.join(sorted(warnings))}


if __name__ == '__main__':
    try:
        print(json.dumps(discover(sys.argv[1])))
    except Exception as error:
        print(json.dumps({'error': str(error)}))
        sys.exit(1)
