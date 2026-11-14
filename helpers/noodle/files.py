"""Scoped filesystem operations. Rename/move never stage Git content."""
from pathlib import Path
import os
import shutil
import stat
import time
import uuid
from storage import fingerprint, read_json, resolve, write_json
from documents import dirty_documents, relocate, settle


def rename(source, destination):
    import ctypes
    libc = ctypes.CDLL(None, use_errno=True)
    if not hasattr(libc, 'renamex_np'):
        raise ValueError('Safe rename requires macOS in this version')
    if libc.renamex_np(os.fsencode(source), os.fsencode(destination), 0x00000004) != 0:
        raise OSError(ctypes.get_errno(), os.strerror(ctypes.get_errno()))


def prepare(request, home):
    root, source = resolve(request)
    operation = request['operation']
    if operation not in ['new_file', 'new_folder', 'rename', 'move', 'duplicate', 'trash']:
        raise ValueError('Unknown file operation')
    destination = resolve(request, 'destination')[1] if operation in ['rename', 'move', 'duplicate'] else None
    if destination and os.path.lexists(destination):
        raise ValueError('An item already exists at that destination')
    if operation.startswith('new_'):
        if os.path.lexists(source):
            raise ValueError('An item already exists at that destination')
    elif not os.path.lexists(source):
        raise ValueError('This item no longer exists')
    if source.is_dir() and not source.is_symlink():
        for count, (_, dirs, names) in enumerate(os.walk(source, followlinks=False)):
            if '.git' in dirs or '.git' in names:
                raise ValueError('Folders containing repositories cannot be moved or deleted here')
            if count >= 2000:
                raise ValueError('This folder is too large to verify safely; use Finder')
        if destination and destination.is_relative_to(source):
            raise ValueError('A folder cannot be moved into itself')
        if operation == 'duplicate':
            raise ValueError('Duplicate is available for individual files')
    records = dirty_documents(home, source)
    return {'root': str(root), 'path': str(source.relative_to(root)), 'destination': str(destination.relative_to(root)) if destination else None,
            'operation': operation, 'snapshot': fingerprint(source),
            'drafts': [{'id': m['id'], 'path': m['path'], 'revision': m['revision']} for m in records]}


def apply(request, home):
    expected = request['prepared']
    current = prepare(expected, home)
    if current['snapshot'] != expected['snapshot']:
        raise ValueError('This item changed. Review the operation again.')
    root, source = resolve(current)
    destination = resolve(current, 'destination')[1] if current['destination'] else None
    records = dirty_documents(home, source)
    versions = {m['id']: m['revision'] for m in expected['drafts']}
    if not settle(home, records, request.get('resolution'), versions):
        return {'needsDraftResolution': True, **current}
    operation = current['operation']
    if operation == 'new_file':
        with open(source, 'xb'):
            pass
    elif operation == 'new_folder':
        source.mkdir()
    elif operation in ['rename', 'move']:
        rename(source, destination)
        relocate(home, source, destination)
    elif operation == 'duplicate':
        if source.is_symlink():
            os.symlink(os.readlink(source), destination)
        else:
            with open(source, 'rb') as original, open(destination, 'xb') as copy:
                shutil.copyfileobj(original, copy)
            shutil.copymode(source, destination)
    elif operation == 'trash':
        trash = Path(os.environ.get('NOODLE_TEST_TRASH', str(Path.home() / '.Trash')))
        trash.mkdir(mode=0o700, parents=True, exist_ok=True)
        if source.lstat().st_dev != trash.stat().st_dev:
            raise ValueError('Use Finder Trash for items on another volume')
        target = trash / (uuid.uuid4().hex[:12] + '-' + source.name)
        rename(source, target)
        journal = read_json(home / 'trash.json', [])
        journal.append({'id': uuid.uuid4().hex, 'root': str(root), 'original': str(source), 'trash': str(target), 'time': time.time()})
        write_json(home / 'trash.json', journal[-100:])
        return {'operation': operation, 'path': current['path'], 'undo': journal[-1]['id']}
    return {'operation': operation, 'path': current['path'], 'destination': current['destination']}


def restore(request, home):
    journal = read_json(home / 'trash.json', [])
    entry = next((entry for entry in journal if entry['id'] == request['id']), None)
    if not entry or not os.path.lexists(entry['trash']):
        raise ValueError('This item is no longer available in Trash')
    root = Path(entry['root'])
    original = Path(entry['original'])
    if not original.parent.resolve().is_relative_to(root) or os.path.lexists(original):
        raise ValueError('The original destination is occupied or unavailable; restore from system Trash')
    rename(entry['trash'], original)
    write_json(home / 'trash.json', [item for item in journal if item != entry])
    return {'path': str(original.relative_to(root)), 'operation': 'restore'}
