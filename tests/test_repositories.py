import importlib.util
from pathlib import Path
import subprocess
import tempfile
import unittest

MODULE = Path(__file__).resolve().parents[1] / 'mods/changes-graph/repositories.py'
spec = importlib.util.spec_from_file_location('repositories', MODULE)
repositories = importlib.util.module_from_spec(spec)
spec.loader.exec_module(repositories)


def git(folder, *args):
    return subprocess.check_output(['git', '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null',
                                    '-c', 'commit.gpgsign=false', *args], cwd=folder, text=True, stderr=subprocess.DEVNULL)


class RepositoryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='herdr-repos-')
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name).resolve()

    def repo(self, name, commit=True):
        folder = self.base / name
        folder.mkdir(parents=True)
        git(folder, 'init', '-q', '-b', 'main')
        git(folder, 'config', 'user.name', 'Fixture')
        git(folder, 'config', 'user.email', 'fixture@example.invalid')
        if commit:
            (folder / 'file.txt').write_text('initial\n')
            git(folder, 'add', '.')
            git(folder, 'commit', '-qm', 'Initial')
        return folder

    def test_sibling_repos_linked_worktree_counts_and_read_only_index(self):
        first = self.repo("café's project")
        second = self.repo('group/second')
        self.repo('node_modules/ignored')
        (self.base / 'alias').symlink_to(second, target_is_directory=True)
        worktree = self.base / 'checkout'
        git(first, 'worktree', 'add', '-qb', 'topic', str(worktree))
        (first / 'new file').write_text('new\n')
        (first / 'file.txt').write_text('changed\n')
        git(first, 'add', 'file.txt')
        (first / 'file.txt').write_text('partially staged\n')
        index = first / '.git/index'
        before = (index.read_bytes(), index.stat().st_mtime_ns)
        result = repositories.discover(str(self.base))
        rows = {r['name']: r for r in result['repositories']}
        self.assertEqual(set(rows), {"café's project", 'group/second', 'checkout'})
        self.assertEqual(rows["café's project"]['count'], 2)
        self.assertEqual(rows['group/second']['count'], 0)
        self.assertEqual(rows['checkout']['branch'], 'topic')
        self.assertTrue(rows['checkout']['worktree'])
        self.assertEqual(before, (index.read_bytes(), index.stat().st_mtime_ns))

    def test_branch_sync_detached_and_unborn(self):
        repo = self.repo('project')
        git(repo, 'switch', '-qc', 'topic')
        git(repo, 'branch', '--set-upstream-to=main')
        (repo / 'file.txt').write_text('next\n')
        git(repo, 'commit', '-am', 'Next', '-q')
        (repo / 'subfolder').mkdir()
        row = repositories.discover(str(repo / 'subfolder'))['repositories'][0]
        self.assertEqual((row['root'], row['branch'], row['ahead'], row['behind']), (str(repo), 'topic', 1, 0))
        git(repo, 'checkout', '--detach', '-q')
        unborn = self.repo('unborn', commit=False)
        (unborn / 'new').write_text('new')
        rows = {r['name']: r for r in repositories.discover(str(self.base))['repositories']}
        self.assertEqual(rows['project']['branch'], '(detached)')
        self.assertEqual((rows['unborn']['branch'], rows['unborn']['count']), ('main', 1))

    def test_depth_limit_is_visible_and_empty_folder_is_valid(self):
        self.assertEqual(repositories.discover(str(self.base))['repositories'], [])
        self.repo('a/b/c/d/e/deep')
        result = repositories.discover(str(self.base))
        self.assertTrue(result['limited'])
        self.assertEqual(result['repositories'], [])


if __name__ == '__main__':
    unittest.main()
