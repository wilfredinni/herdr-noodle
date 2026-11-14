"""Raw document snapshots; displayed preview rows never enter this store."""
from pathlib import Path
import os
import time
from storage import atomic, fingerprint, identity, read_json, resolve, save_text, text, write_json


def paths(home, doc_id):
    if len(doc_id) != 64 or any(c not in '0123456789abcdef' for c in doc_id):
        raise ValueError('Invalid document identity')
    folder = home / 'drafts' / doc_id
    folder.mkdir(mode=0o700, parents=True, exist_ok=True)
    return {key: folder / key for key in ['base', 'draft', 'input', 'merge-base', 'note-input', 'notes.json', 'meta.json']}


def record(home, doc_id):
    p = paths(home, doc_id)
    meta = read_json(p['meta.json'])
    if not meta:
        raise ValueError('This document is no longer available')
    return p, meta


def dirty_documents(home, path):
    records = []
    for entry in (home / 'drafts').glob('*/meta.json'):
        meta = read_json(entry)
        if not meta or not meta.get('dirty'):
            continue
        source = Path(meta['absolute'])
        if source == path or source.is_relative_to(path):
            records.append(meta)
    return records


def sync(p, meta, value):
    for name in ['base', 'draft', 'input']:
        atomic(p[name], value.encode())
    meta.update(dirty=False, revision=meta.get('revision', 0) + 1, updated=time.time())
    write_json(p['meta.json'], meta)


def handle(action, request, home):
    if action == 'document_open':
        root, path = resolve(request)
        if path.is_symlink() or not path.resolve().is_relative_to(root):
            raise ValueError('Edit the link target directly inside the selected folder')
        disk = text(path)
        doc_id = identity(path)
        p = paths(home, doc_id)
        meta = read_json(p['meta.json'])
        if meta and p['input'].exists() and text(p['input']) != text(p['base']):
            atomic(p['draft'], p['input'].read_bytes())
            meta.update(dirty=True, revision=meta['revision'] + 1)
            write_json(p['meta.json'], meta)
        if not meta or not meta.get('dirty'):
            meta = {'id': doc_id, 'absolute': str(path), 'root': str(root), 'path': str(path.relative_to(root)), 'revision': 0}
            sync(p, meta, disk)
        base, draft = text(p['base']), text(p['draft'])
        # The input is a private transport file for the native save API, never a process argument.
        atomic(p['input'], draft.encode())
        return {**meta, 'root': str(root), 'path': str(path.relative_to(root)), 'base': base, 'draft': draft, 'disk': disk,
                'conflict': disk != base, 'inputPath': str(p['input']), 'inputValue': draft, 'snapshot': fingerprint(path)}
    p, meta = record(home, request['id'])
    if action == 'document_note_prepare':
        atomic(p['note-input'], b'')
        return {'path': str(p['note-input']), 'notes': read_json(p['notes.json'], [])}
    if action == 'document_note_save':
        note = {'range': request.get('range'), 'commit': request.get('commit'), 'text': text(p['note-input']), 'time': time.time()}
        notes = read_json(p['notes.json'], [])
        notes.append(note)
        write_json(p['notes.json'], notes[-100:])
        return {'notes': notes[-100:]}
    if action == 'document_checkpoint':
        draft = text(p['input'])
        atomic(p['draft'], draft.encode())
        meta.update(dirty=draft != text(p['base']), revision=meta['revision'] + 1, updated=time.time())
        write_json(p['meta.json'], meta)
        return {'dirty': meta['dirty'], 'revision': meta['revision']}
    if action == 'document_saved':
        disk = text(meta['absolute'])
        if disk != text(p['input']):
            raise ValueError('The file changed again after saving. Your draft is preserved.')
        sync(p, meta, disk)
        return {'base': disk, 'revision': meta['revision'], 'dirty': False}
    if action == 'document_discard':
        disk = text(meta['absolute'])
        sync(p, meta, disk)
        return {'base': disk, 'draft': disk, 'revision': meta['revision'], 'dirty': False}
    if action == 'document_conflict':
        disk = text(meta['absolute'])
        atomic(p['merge-base'], disk.encode())
        return {'base': text(p['base']), 'draft': text(p['draft']), 'disk': disk}
    if action == 'document_accept_disk':
        disk = text(meta['absolute'])
        if disk != text(p['merge-base']):
            raise ValueError('The disk version changed again. Compare it before saving.')
        atomic(p['base'], disk.encode())
        meta.update(dirty=text(p['draft']) != disk, revision=meta['revision'] + 1)
        write_json(p['meta.json'], meta)
        return {'base': disk}
    raise ValueError('Unknown document operation')


def settle(home, records, resolution, expected):
    for meta in records:
        if expected.get(meta['id']) != meta['revision']:
            raise ValueError('A draft changed. Review the file operation again.')
    if records and resolution not in ['save', 'discard']:
        return False
    for meta in records:
        p, current = record(home, meta['id'])
        if resolution == 'save':
            save_text(current['absolute'], text(p['draft']), text(p['base']))
        sync(p, current, text(current['absolute']))
    return True


def relocate(home, source, destination):
    for entry in (home / 'drafts').glob('*/meta.json'):
        meta = read_json(entry)
        old = Path(meta['absolute'])
        if old == source or old.is_relative_to(source):
            new = destination / old.relative_to(source) if old != source else destination
            p = entry.parent
            meta.update(absolute=str(new), path=str(new.relative_to(Path(meta['root']))))
            target = paths(home, identity(new))
            meta['id'] = identity(new)
            for name in ['base', 'draft', 'input', 'note-input', 'notes.json']:
                if (p / name).exists():
                    os.replace(p / name, target[name])
            write_json(target['meta.json'], meta)
            entry.unlink()
