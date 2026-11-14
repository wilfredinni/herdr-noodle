"""Explicit per-repository tasks, each in its own core terminal."""
import json
import os
from pathlib import Path
import re
import subprocess
import time
import uuid
from documents import dirty_documents, settle
from storage import atomic, identity, read_json, resolve, write_json


def hc(*args):
    result = subprocess.run(['hc', *args], capture_output=True, text=True, timeout=15)
    if result.returncode:
        raise ValueError(result.stderr.strip() or 'The task terminal is unavailable')
    return json.loads(result.stdout or '{}')


def records(home, root):
    folder = home / 'tasks' / identity(root)
    folder.mkdir(mode=0o700, parents=True, exist_ok=True)
    return folder


def suggestions(root):
    package = read_json(root / 'package.json', {})
    manager = 'bun' if (root / 'bun.lock').exists() or (root / 'bun.lockb').exists() else 'pnpm' if (root / 'pnpm-lock.yaml').exists() else 'yarn' if (root / 'yarn.lock').exists() else 'npm'
    return [{'name': name, 'command': f'{manager} run {name}'} for name in package.get('scripts', {}) if re.fullmatch(r'[\w:.-]{1,80}', name)][:40]


def handle(action, request, home):
    root, _ = resolve({**request, 'path': ''}, allow_root=True)
    folder = records(home, root)
    config = read_json(folder / 'saved.json', [])
    runs = sorted([read_json(p) for p in folder.glob('run-*.json')], key=lambda r: r['started'], reverse=True)
    if action == 'tasks_list':
        for run in runs:
            if run['state'] not in ['starting', 'running']:
                continue
            try:
                terminal = hc('get', '--json', run['name'])
                # Lost processes are never restarted or adopted by this panel.
                if 'lost' in json.dumps(terminal).lower():
                    raise ValueError('Lost task')
            except (ValueError, subprocess.TimeoutExpired):
                run.update(state='interrupted', ended=time.time())
                write_json(folder / f"run-{run['id']}.json", run)
        return {'saved': config, 'suggestions': suggestions(root), 'runs': runs[:20]}
    if action == 'task_save':
        name, command = request.get('name', '').strip(), request.get('command', '').strip()
        if not name or not command or len(name) > 80 or len(command) > 4000 or '\0' in command:
            raise ValueError('Enter a task name and a command under 4,000 characters')
        config = [item for item in config if item['name'] != name] + [{'name': name, 'command': command}]
        write_json(folder / 'saved.json', config[-40:])
        return {'saved': config[-40:]}
    if action == 'task_run':
        dirty = dirty_documents(home, root)
        if dirty and request.get('resolution') not in ['save', 'saved']:
            return {'needsDraftResolution': True, 'drafts': [{'id': m['id'], 'revision': m['revision']} for m in dirty]}
        if dirty and request.get('resolution') == 'save':
            settle(home, dirty, 'save', {m['id']: m['revision'] for m in request.get('drafts', [])})
        task = next((t for t in config + suggestions(root) if t['name'] == request['name']), None)
        if not task: raise ValueError('Save this task before running it')
        run_id = uuid.uuid4().hex
        run = {'id': run_id, 'name': 'nd-' + run_id[:20], 'title': task['name'], 'command': task['command'], 'root': str(root), 'state': 'starting', 'started': time.time()}
        write_json(folder / f'run-{run_id}.json', run)
        try:
            terminal = hc('run', '--json', '--bg', '--name', run['name'], '--cwd', str(root), '--label', 'noodle-task=' + run_id, '--no-parent', '--no-notify', 'python3', str(Path(__file__).with_name('task_runner.py')), str(folder / f'run-{run_id}.json'))
        except Exception:
            run.update(state='interrupted', ended=time.time()); write_json(folder / f'run-{run_id}.json', run); raise
        return {'run': read_json(folder / f'run-{run_id}.json'), 'terminal': terminal}
    run = next((r for r in runs if r['id'] == request.get('id')), None)
    if not run: raise ValueError('This task run is unavailable')
    if action == 'task_output':
        log = folder / f"run-{run['id']}.log"
        output = log.read_bytes().decode('utf-8', 'replace') if log.exists() else ''
        diagnostics = []
        for line in output.splitlines():
            match = re.search(r'(?:^|\s)([^\s:]+):(\d+)(?::(\d+))?', line)
            if match:
                file = Path(match[1]); file = file if file.is_absolute() else root / file
                if file.resolve().is_relative_to(root) and file.is_file():
                    diagnostics.append({'path': str(file.relative_to(root)), 'line': int(match[2]), 'column': int(match[3] or 1)})
        return {'run': run, 'text': output[-200000:], 'diagnostics': diagnostics[:100], 'truncated': len(output) > 200000}
    if action == 'task_stop':
        if run['state'] not in ['starting', 'running']: raise ValueError('This task has already finished')
        terminal = hc('get', '--json', run['name'])
        serialized = json.dumps(terminal)
        if run['id'] not in serialized or run['name'] not in serialized:
            raise ValueError('Terminal ownership could not be verified; no stop signal was sent')
        hc('kill' if request.get('force') is True else 'interrupt', '--json', run['name'])
        return {'stopped': True}
    raise ValueError('Unknown task operation')
