"""All mutations use disposable folders and an isolated Trash."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'helpers' / 'noodle'))
from workspace import dispatch
from storage import text, LIMIT


class WorkspaceFixture(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.root = self.base / 'repo'; self.root.mkdir()
        self.home = self.base / 'app'; self.home.mkdir()
        self.env = patch.dict(os.environ, {'NOODLE_TEST_TRASH': str(self.base / 'trash')}); self.env.start(); self.addCleanup(self.env.stop)
    def call(self, action, **kw):
        return dispatch(action, {'root': str(self.root), 'home': str(self.home), **kw})
    def file(self, path='one.txt', data=b'hello\n'):
        (self.root / path).write_bytes(data)
        return self.root / path
    def operation(self, operation, path, **kw):
        prepared = self.call('file_prepare', operation=operation, path=path, **kw)
        return self.call('file_apply', prepared=prepared)

class WorkspaceTests(WorkspaceFixture):
    def test_raw_snapshots_recovery_and_conflicts(self):
        for raw in [b'', b'\xef\xbb\xbf\tEspa\xc3\xb1ol\r\nnext\r\n', b'no newline', b'a\r\nb\n']:
            file = self.file(data=raw)
            doc = self.call('document_open', path=file.name)
            self.assertEqual(doc['base'].encode(), raw)
            self.assertEqual(doc['draft'].encode(), raw)
            self.assertEqual(os.stat(doc['inputPath']).st_mode & 0o777, 0o600)
            Path(doc['inputPath']).write_bytes(raw + b'changed')
            self.call('document_checkpoint', id=doc['id'])
            recovered = self.call('document_open', path=file.name)
            self.assertTrue(recovered['dirty'])
            self.assertEqual(recovered['draft'].encode(), raw + b'changed')
            file.write_bytes(b'agent change')
            self.assertTrue(self.call('document_open', path=file.name)['conflict'])
            comparison = self.call('document_conflict', id=doc['id'])
            self.assertEqual(comparison['disk'], 'agent change')
            file.write_bytes(b'agent changed again')
            with self.assertRaisesRegex(ValueError, 'changed again'):
                self.call('document_accept_disk', id=doc['id'])
            self.call('document_discard', id=doc['id'])
    def test_binary_large_and_non_utf8_are_never_editable(self):
        for value in [b'a\0b', b'\xff', b'x' * (LIMIT + 1)]:
            self.file(data=value)
            with self.assertRaises(ValueError): self.call('document_open', path='one.txt')
    def test_create_rename_duplicate_move_and_no_overwrite(self):
        self.operation('new_file', 'one.txt')
        self.operation('new_folder', 'folder')
        self.file(data=b'keep\r\n')
        self.operation('duplicate', 'one.txt', destination='copy.txt')
        self.operation('rename', 'one.txt', destination='folder/renamed.txt')
        self.assertEqual((self.root / 'copy.txt').read_bytes(), b'keep\r\n')
        self.assertEqual((self.root / 'folder/renamed.txt').read_bytes(), b'keep\r\n')
        with self.assertRaisesRegex(ValueError, 'already exists'):
            self.operation('rename', 'copy.txt', destination='folder/renamed.txt')
        with self.assertRaises(ValueError): self.operation('new_file', 'copy.txt')
    def test_path_boundaries_and_symlinks(self):
        self.file(); (self.root / '.git').mkdir()
        (self.root / 'outside').symlink_to(self.base, target_is_directory=True)
        for path in ['', '..', '../bad', '/tmp/bad', '.git/config', 'outside/escaped']:
            with self.assertRaises((ValueError, FileNotFoundError)):
                self.operation('new_file', path)
        (self.root / 'link').symlink_to(self.base / 'absent')
        with self.assertRaises(ValueError): self.call('document_open', path='link')
        self.operation('trash', 'link')
        self.assertFalse(os.path.lexists(self.root / 'link'))
    def test_dirty_resolution_and_relocation(self):
        file = self.file(); doc = self.call('document_open', path=file.name)
        Path(doc['inputPath']).write_bytes(b'draft')
        self.call('document_checkpoint', id=doc['id'])
        prepared = self.call('file_prepare', operation='rename', path=file.name, destination='new.txt')
        self.assertTrue(self.call('file_apply', prepared=prepared)['needsDraftResolution'])
        self.assertTrue(file.exists())
        self.call('file_apply', prepared=prepared, resolution='save')
        self.assertEqual((self.root / 'new.txt').read_bytes(), b'draft')
        new = self.call('document_open', path='new.txt')
        self.assertFalse(new['dirty'])
    def test_stale_draft_or_file_does_not_mutate(self):
        file = self.file(); doc = self.call('document_open', path=file.name)
        Path(doc['inputPath']).write_bytes(b'draft'); self.call('document_checkpoint', id=doc['id'])
        prepared = self.call('file_prepare', operation='trash', path=file.name)
        self.call('document_checkpoint', id=doc['id'])
        with self.assertRaisesRegex(ValueError, 'draft changed'):
            self.call('file_apply', prepared=prepared, resolution='save')
        self.assertTrue(file.exists())
        file.write_text('agent')
        with self.assertRaisesRegex(ValueError, 'item changed'):
            self.call('file_apply', prepared=prepared, resolution='discard')
    def test_trash_restore_collision_never_overwrites(self):
        file = self.file(); result = self.operation('trash', file.name)
        self.assertFalse(file.exists()); file.write_text('new')
        with self.assertRaisesRegex(ValueError, 'occupied'):
            self.call('file_restore', id=result['undo'])
        self.assertEqual(file.read_text(), 'new')
        file.unlink(); self.call('file_restore', id=result['undo'])
        self.assertEqual(file.read_text(), 'hello\n')
    def test_search_honors_ignores_hidden_case_unicode_and_lines(self):
        subprocess.run(['git', 'init', '-q', str(self.root)], check=True)
        self.file('.gitignore', b'ignored.txt\n'); self.file('ignored.txt', b'needle')
        self.file('.hidden', 'Needle espa\u00f1ol\nsecond needle\n'.encode())
        result = self.call('search', mode='content', query='needle')
        self.assertEqual([(m['path'], m['line']) for m in result['items']], [('.hidden', 1), ('.hidden', 2)])
        result = self.call('search', mode='content', query='Needle', matchCase=True)
        self.assertEqual(len(result['items']), 1)
        self.assertEqual(self.call('search', mode='files', query='hid')['items'][0]['path'], '.hidden')

if __name__ == '__main__': unittest.main()

class ReviewTaskTests(WorkspaceFixture):
    def git(self, *args):
        return subprocess.check_output(['git', '-c', 'core.fsmonitor=false', *args], cwd=self.root).decode().strip()
    def setup_git(self):
        self.git('init', '-q', '-b', 'main'); self.git('config', 'user.name', 'Fixture'); self.git('config', 'user.email', 'fixture@example.invalid')
        self.file(data=b'one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\n')
        self.git('add', '.'); self.git('-c', 'commit.gpgsign=false', 'commit', '-qm', 'Base')
    def test_partial_staging_undo_and_stale_snapshot(self):
        self.setup_git(); file = self.root / 'one.txt'
        file.write_text(file.read_text().replace('one\n', 'ONE\n').replace('ten\n', 'TEN\n'))
        result = self.call('review_hunks', path='one.txt', mode='unstaged')
        self.assertEqual(len(result['hunks']), 2)
        self.call('review_apply', token=result['token'], hunk=0, operation='stage')
        self.assertIn('ONE', self.git('show', ':one.txt')); self.assertNotIn('TEN', self.git('show', ':one.txt'))
        with self.assertRaises(ValueError): self.call('review_apply', token=result['token'], hunk=1, operation='stage')
        staged = self.call('review_hunks', path='one.txt', mode='staged')
        self.call('review_apply', token=staged['token'], hunk=0, operation='unstage')
        self.assertEqual(self.git('diff', '--cached'), '')
        fresh = self.call('review_hunks', path='one.txt', mode='unstaged')
        file.write_text(file.read_text() + 'agent\n')
        with self.assertRaisesRegex(ValueError, 'changed'):
            self.call('review_apply', token=fresh['token'], hunk=0, operation='discard', confirmed=True)
    def test_discard_requires_confirmation_and_keeps_recovery(self):
        self.setup_git(); file = self.root / 'one.txt'; original = file.read_bytes(); file.write_bytes(original + b'new\n')
        result = self.call('review_hunks', path='one.txt')
        with self.assertRaisesRegex(ValueError, 'Confirm'):
            self.call('review_apply', token=result['token'], hunk=0, operation='discard')
        self.call('review_apply', token=result['token'], hunk=0, operation='discard', confirmed=True)
        self.assertEqual(file.read_bytes(), original)
        self.assertEqual(next((self.home / 'data/noodle/discarded').glob('*.file')).read_bytes(), original + b'new\n')
    def test_compare_uses_merge_base_and_only_reads(self):
        self.setup_git(); self.git('branch', 'base'); self.file('second.txt', b'next'); self.git('add', '.'); self.git('-c', 'commit.gpgsign=false', 'commit', '-qm', 'Second')
        result = self.call('review_compare', ref='base')
        self.assertEqual(result['files'], [{'status': 'A', 'path': 'second.txt'}])
        self.assertEqual(self.git('status', '--porcelain'), '')
    def test_task_saved_config_dirty_guard_and_ownership(self):
        self.file(); doc = self.call('document_open', path='one.txt'); Path(doc['inputPath']).write_text('draft'); self.call('document_checkpoint', id=doc['id'])
        self.call('task_save', name='test', command='printf fixture')
        prompt = self.call('task_run', name='test')
        self.assertTrue(prompt['needsDraftResolution'])
        with patch('tasks.hc', return_value={'terminal': 'fixture-only'}) as hc:
            result = self.call('task_run', name='test', resolution='saved')
            self.assertIn('--no-parent', hc.call_args.args)
            self.assertEqual((self.root / 'one.txt').read_text(), 'hello\n')
        with patch('tasks.hc', return_value={'name': 'some-other-terminal'}) as hc:
            with self.assertRaisesRegex(ValueError, 'ownership'):
                self.call('task_stop', id=result['run']['id'])
            self.assertEqual(hc.call_count, 1)
    def test_task_runner_logs_exit_code_and_diagnostics(self):
        self.file(); self.call('task_save', name='test', command="printf 'one.txt:2:1: failure\\n'; exit 3")
        with patch('tasks.hc', return_value={}): result = self.call('task_run', name='test')
        folder = next((self.home / 'data/noodle/tasks').iterdir())
        runfile = folder / ('run-' + result['run']['id'] + '.json')
        runner = Path(__file__).resolve().parents[1] / 'helpers/noodle/task_runner.py'
        completed = subprocess.run([sys.executable, str(runner), str(runfile)], capture_output=True)
        self.assertEqual(completed.returncode, 3)
        output = self.call('task_output', id=result['run']['id'])
        self.assertEqual(output['run']['state'], 'failed'); self.assertEqual(output['run']['code'], 3)
        self.assertEqual(output['diagnostics'][0]['path'], 'one.txt')
    def test_assets_reject_external_svg_and_keep_source_unchanged(self):
        for value in [b'<svg><script>alert(1)</script></svg>', b'<svg><image href="https://example.invalid/secret"/></svg>', b'<!DOCTYPE svg><svg/>']:
            file = self.file('asset.svg', value)
            with self.assertRaises(ValueError): self.call('asset_preview', path='asset.svg')
            self.assertEqual(file.read_bytes(), value)
