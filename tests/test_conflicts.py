import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / 'mods/git-file-preview/conflict.py'
spec = importlib.util.spec_from_file_location('conflict', SCRIPT)
conflict = importlib.util.module_from_spec(spec)
spec.loader.exec_module(conflict)


class ConflictTests(unittest.TestCase):
    def git(self, root, *args, check=True):
        return subprocess.run(['git', '-c', 'core.fsmonitor=false', '-c', 'commit.gpgsign=false', *args], cwd=root, capture_output=True, check=check).stdout.decode()

    def fixture(self, root):
        self.git(root, 'init', '-q', '-b', 'main')
        self.git(root, 'config', 'user.name', 'Fixture')
        self.git(root, 'config', 'user.email', 'fixture@example.invalid')
        file = Path(root) / 'file.txt'
        file.write_text('prefix\nbase\nsuffix\n')
        self.git(root, 'add', '.'); self.git(root, 'commit', '-qm', 'Baseline')
        self.git(root, 'checkout', '-qb', 'incoming')
        file.write_text('prefix\nincoming\nsuffix\n')
        self.git(root, 'commit', '-qam', 'Incoming')
        self.git(root, 'checkout', '-q', 'main')
        file.write_text('prefix\ncurrent\nsuffix\n')
        self.git(root, 'commit', '-qam', 'Current')
        self.git(root, 'merge', 'incoming', check=False)
        return file

    def call(self, root, *args, check=True):
        result = subprocess.run(['python3', str(SCRIPT), root, 'file.txt', *args], capture_output=True, text=True)
        if check:
            self.assertEqual(result.returncode, 0, result.stderr)
        return result

    def test_confirmed_resolutions_preserve_context_and_stage_the_result(self):
        for choice, expected in [('ours', 'current\n'), ('theirs', 'incoming\n'), ('both', 'current\nincoming\n')]:
            with self.subTest(choice=choice), tempfile.TemporaryDirectory() as root:
                file = self.fixture(root)
                review = json.loads(self.call(root, 'inspect').stdout)
                self.assertEqual(review['count'], 1)
                head = self.git(root, 'rev-parse', 'HEAD').strip()
                self.call(root, choice, review['signature'], head, 'main')
                self.assertEqual(file.read_text(), 'prefix\n' + expected + 'suffix\n')
                self.assertEqual(self.git(root, 'ls-files', '--unmerged'), '')
                self.assertEqual(self.git(root, 'show', ':file.txt'), file.read_text())

    def test_stale_content_index_and_head_are_rejected(self):
        for change in ['content', 'index', 'head']:
            with self.subTest(change=change), tempfile.TemporaryDirectory() as root:
                file = self.fixture(root)
                review = json.loads(self.call(root, 'inspect').stdout)
                head = self.git(root, 'rev-parse', 'HEAD').strip()
                if change == 'content':
                    file.write_text(file.read_text() + 'new work\n')
                elif change == 'index':
                    self.git(root, 'add', 'file.txt')
                else:
                    self.git(root, 'update-ref', 'HEAD', 'HEAD~1')
                before = file.read_bytes()
                result = self.call(root, 'ours', review['signature'], head, 'main', check=False)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(file.read_bytes(), before)

    def test_manually_resolved_files_can_be_marked_resolved(self):
        with tempfile.TemporaryDirectory() as root:
            file = self.fixture(root); file.write_text('manual resolution\n')
            review = json.loads(self.call(root, 'inspect').stdout)
            self.assertEqual(review['count'], 0)
            self.call(root, 'resolved', review['signature'], self.git(root, 'rev-parse', 'HEAD').strip(), 'main')
            self.assertEqual(self.git(root, 'show', ':file.txt'), 'manual resolution\n')

    def test_diff3_crlf_multiple_blocks_and_malformed_markers(self):
        data = b'prefix\r\n<<<<<<< HEAD\r\nours\r\n||||||| base\r\nbase\r\n=======\r\ntheirs\r\n>>>>>>> incoming\r\nsuffix\r\n'
        resolved, count = conflict.resolve(data + data, 'both')
        self.assertEqual(count, 2)
        self.assertEqual(resolved, b'prefix\r\nours\r\ntheirs\r\nsuffix\r\n' * 2)
        for malformed in [b'<<<<<<< HEAD\nx\n', b'=======\n', b'<<<<<<< HEAD\n<<<<<<< nested\n', data]:
            with self.subTest(malformed=malformed):
                with self.assertRaises(ValueError):
                    conflict.resolve(malformed, 'resolved')

    def test_symlink_binary_and_large_conflicts_are_rejected(self):
        for kind in ['symlink', 'binary', 'large']:
            with self.subTest(kind=kind), tempfile.TemporaryDirectory() as root:
                file = self.fixture(root)
                if kind == 'symlink':
                    other = Path(root) / 'other.txt'; other.write_text('preserve\n'); file.unlink(); file.symlink_to(other)
                else:
                    file.write_bytes(b'\0' if kind == 'binary' else b'x' * 400001)
                self.assertNotEqual(self.call(root, 'inspect', check=False).returncode, 0)


if __name__ == '__main__':
    unittest.main()
