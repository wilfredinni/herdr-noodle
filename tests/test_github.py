"""GitHub fixtures and disposable Git repositories; never contacts GitHub."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'helpers/noodle'))
import github as gh
from workspace import dispatch
from storage import state_home

REPO = {'name': 'example/repo', 'ref': 'github.com/example/repo', 'host': 'github.com'}


class GithubTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / 'repo'; self.root.mkdir()
        self.home = Path(self.temp.name) / 'app'; self.home.mkdir()
        self.git('init', '-q', '-b', 'main'); self.git('config', 'user.name', 'Fixture'); self.git('config', 'user.email', 'fixture@example.invalid')
        (self.root / 'file.txt').write_text('baseline\n'); self.git('add', '.'); self.git('commit', '-qm', 'Baseline')
        self.base = self.git('rev-parse', 'HEAD')
        self.git('switch', '-qc', 'feature')
        (self.root / 'file.txt').write_text('committed change\n'); self.git('commit', '-qam', 'Add feature')
        self.head = self.git('rev-parse', 'HEAD')
        self.request = {'home': str(self.home), 'root': str(self.root), 'head': self.head, 'branch': 'feature', 'base': 'main', 'title': 'Add feature', 'body': 'Reviewed body', 'draft': True}

    def git(self, *args):
        return subprocess.check_output(['git', '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', *args], cwd=self.root, text=True, stderr=subprocess.DEVNULL).strip()

    def test_network_does_not_take_document_lock(self):
        with patch('workspace.locked', side_effect=AssertionError('editor locked')), patch.object(gh, 'handle', return_value={'items': []}) as call:
            self.assertEqual(dispatch('github_prs', self.request), {'items': []})
            call.assert_called_once()

    def test_private_transport_cleanup_and_scope(self):
        prepared = dispatch('github_prepare', self.request)
        file = Path(prepared['path'])
        self.assertEqual(file.stat().st_mode & 0o777, 0o600)
        file.write_text(json.dumps(self.request))
        with patch.object(gh, 'create', return_value={'url': 'https://github.com/example/repo/pull/1'}) as create:
            dispatch('github_create', {**self.request, 'token': prepared['token']})
            self.assertEqual(create.call_args.args[0]['body'], 'Reviewed body')
        self.assertFalse(file.exists())
        with self.assertRaises(ValueError):
            dispatch('github_create', {**self.request, 'token': '../secrets'})

    def test_template_detection_and_validation(self):
        (self.root / '.github').mkdir(); (self.root / '.github/PULL_REQUEST_TEMPLATE.md').write_text('## Validation\n')
        (self.root / '.github/PULL_REQUEST_TEMPLATE').mkdir()
        (self.root / '.github/PULL_REQUEST_TEMPLATE/fix.md').write_text('Fix template')
        self.assertEqual(len(gh.templates(self.root)), 2)
        self.assertEqual(gh.template(self.root, '.github/PULL_REQUEST_TEMPLATE.md'), '## Validation\n')
        self.assertEqual(gh.template(self.root, str(self.root / '.github/PULL_REQUEST_TEMPLATE.md')), '## Validation\n')
        (self.root / 'binary').write_bytes(b'\0')
        with self.assertRaises(ValueError): gh.template(self.root, 'binary')
        outside = Path(self.temp.name) / 'outside.md'; outside.write_text('Explicitly selected outside template')
        (self.root / 'linked.md').symlink_to(outside)
        with self.assertRaisesRegex(ValueError, 'explicit absolute path'): gh.template(self.root, 'linked.md')
        self.assertEqual(gh.template(self.root, str(outside)), outside.read_text())

    def test_snapshot_uses_committed_diff_only_and_does_not_change_index(self):
        (self.root / 'file.txt').write_text('DO NOT SEND UNSTAGED CONTENT\n')
        (self.root / 'new.txt').write_text('DO NOT SEND NEW FILE\n'); self.git('add', 'new.txt')
        before = (self.root / '.git/index').read_bytes()
        with patch.object(gh, 'repository', return_value=REPO), patch.object(gh, 'api', return_value={'sha': self.base}):
            value = gh.branch_snapshot(self.request)
        self.assertIn('committed change', value['payload']); self.assertIn('Add feature', value['payload'])
        self.assertNotIn('DO NOT SEND', value['payload']); self.assertEqual(before, (self.root / '.git/index').read_bytes())

    def test_stale_branch_fails_before_network(self):
        with patch.object(gh, 'repository') as network:
            with self.assertRaisesRegex(ValueError, 'branch changed'):
                gh.branch_snapshot({**self.request, 'head': '0' * 40})
            network.assert_not_called()

    def test_create_requires_matching_published_head(self):
        with patch.object(gh, 'repository', return_value=REPO), patch.object(gh, 'api', return_value={'object': {'sha': self.base}}), patch.object(gh, 'existing') as existing:
            with self.assertRaisesRegex(ValueError, 'Publish or push'):
                gh.create(self.request)
            existing.assert_not_called()

    def test_create_uses_body_file_and_explicit_head_base_draft_without_push(self):
        original = gh.command
        calls = []
        def command(args, root, **kw):
            if args[0] == 'git': return original(args, root, **kw)
            calls.append(args)
            self.assertEqual(Path(args[args.index('--body-file') + 1]).read_text(), self.request['body'])
            self.assertNotIn(self.request['body'], args)
            return 'https://github.com/example/repo/pull/7\n'
        with patch.object(gh, 'repository', return_value=REPO), patch.object(gh, 'api', return_value={'object': {'sha': self.head}}), patch.object(gh, 'existing', return_value=None), patch.object(gh, 'command', side_effect=command):
            self.assertTrue(gh.create(self.request)['url'].endswith('/7'))
        args = calls[0]
        self.assertEqual(args[args.index('--head') + 1], 'feature'); self.assertEqual(args[args.index('--base') + 1], 'main'); self.assertIn('--draft', args)
        self.assertFalse(Path(args[args.index('--body-file') + 1]).exists())

    def test_existing_pr_prevents_resubmission(self):
        prior = {'url': 'https://github.com/example/repo/pull/7', 'number': 7}
        with patch.object(gh, 'repository', return_value=REPO), patch.object(gh, 'api', return_value={'object': {'sha': self.head}}), patch.object(gh, 'existing', return_value=prior):
            self.assertTrue(gh.create(self.request)['existing'])

    def test_timeout_checks_for_created_pr_before_retry(self):
        original = gh.command
        def command(args, root, **kw):
            if args[0] == 'git': return original(args, root, **kw)
            raise ValueError('GitHub timed out')
        prior = {'url': 'https://github.com/example/repo/pull/8', 'number': 8}
        with patch.object(gh, 'repository', return_value=REPO), patch.object(gh, 'api', return_value={'object': {'sha': self.head}}), patch.object(gh, 'existing', side_effect=[None, prior]), patch.object(gh, 'command', side_effect=command):
            self.assertEqual(gh.create(self.request)['number'], 8)

    def test_reviews_and_replies_are_paginated(self):
        first = {'id': 'thread', 'path': 'file.txt', 'line': 2, 'isResolved': False,
                 'comments': {'nodes': [{'id': 'one'}], 'pageInfo': {'hasNextPage': True, 'endCursor': 'reply-cursor'}}}
        responses = [
            {'data': {'repository': {'pullRequest': {'reviewThreads': {'nodes': [first], 'pageInfo': {'hasNextPage': True, 'endCursor': 'thread-cursor'}}}}}},
            {'data': {'repository': {'pullRequest': {'reviewThreads': {'nodes': [], 'pageInfo': {'hasNextPage': False}}}}}},
        ]
        with patch.object(gh, 'command', side_effect=[json.dumps(value) for value in responses]) as commands, patch.object(gh, 'api', return_value={'data': {'node': {'comments': {'nodes': [{'id': 'two'}], 'pageInfo': {'hasNextPage': False}}}}}) as api:
            values = gh.threads(self.root, REPO, 1)
            self.assertEqual([v['id'] for v in values[0]['comments']], ['one', 'two'])
            self.assertIn('after=thread-cursor', commands.call_args.args[0]); self.assertEqual(api.call_args.args[3]['after'], 'reply-cursor')

    def test_review_pagination_failure_is_not_reported_as_complete(self):
        with patch.object(gh, 'command', return_value=json.dumps({'errors': [{'message': 'denied'}]})):
            with self.assertRaisesRegex(ValueError, 'complete review threads'):
                gh.threads(self.root, REPO, 1)
        with patch.object(gh, 'api', side_effect=[[{'id': i} for i in range(100)], [{'id': 101}]]):
            self.assertEqual(len(gh.pages(self.root, REPO, 'reviews')), 101)

    def test_runs_filter_and_job_validation(self):
        home = state_home(self.request)
        with patch.object(gh, 'repository', return_value=REPO), patch.object(gh, 'api', return_value={'workflow_runs': []}) as api:
            gh.handle('github_runs', {**self.request, 'branch': 'feat/a b', 'page': 2}, home)
            self.assertIn('branch=feat%2Fa%20b', api.call_args.args[2]); self.assertIn('page=2', api.call_args.args[2])
        with patch.object(gh, 'api', side_effect=[{'repository': {'full_name': REPO['name']}}, {'run_id': 2}]):
            with self.assertRaisesRegex(ValueError, 'does not belong'):
                gh.log(self.root, REPO, 1, job=3)

    def test_logs_keep_bounded_tail_and_sha(self):
        executable = Path(self.temp.name) / 'gh'
        executable.write_text('#!/usr/bin/env python3\nprint("x" * 220000)\n'); executable.chmod(0o700)
        with patch.dict(os.environ, {'PATH': str(executable.parent) + os.pathsep + os.environ['PATH']}), patch.object(gh, 'api', return_value={'repository': {'full_name': REPO['name']}, 'head_sha': self.head}):
            value = gh.log(self.root, REPO, 1)
        self.assertEqual(len(value['text']), 200000); self.assertTrue(value['truncated']); self.assertEqual(value['head'], self.head)

    def test_location_uses_reviewed_commit_and_handles_missing_object(self):
        value = {'head': {'sha': self.head}, 'base': {'sha': self.base}}
        with patch.object(gh, 'repository', return_value=REPO), patch.object(gh, 'pull', return_value=value):
            result = gh.handle('github_location', {**self.request, 'number': 1, 'path': 'file.txt'}, state_home(self.request))
            self.assertEqual(result['head'], self.head)
            with self.assertRaises(ValueError): gh.handle('github_location', {**self.request, 'number': 1, 'path': '../escape'}, state_home(self.request))
            value['head']['sha'] = '0' * 40
            self.assertFalse(gh.handle('github_location', {**self.request, 'number': 1, 'path': 'file.txt'}, state_home(self.request))['local'])

    def test_missing_gh_and_timeout_are_actionable(self):
        with patch.object(gh.subprocess, 'run', side_effect=FileNotFoundError):
            with self.assertRaisesRegex(ValueError, 'gh auth login'): gh.command(['gh'], self.root)
        with patch.object(gh.subprocess, 'run', side_effect=subprocess.TimeoutExpired('gh', 25)):
            with self.assertRaisesRegex(ValueError, 'timed out'): gh.command(['gh'], self.root)

    def test_pr_generation_uses_provider_with_template_and_checks_staleness(self):
        spec = importlib.util.spec_from_file_location('pr_generate', ROOT / 'mods/changes-graph/generate.py')
        module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
        request = {**self.request, 'connection': 'codex', 'model': 'test', 'instructions': 'Use Conventional Commits.'}
        before = {'payload': 'committed diff', 'template': '## Validation', 'fingerprint': 'same'}
        catalog = {'connections': [{'id': 'codex', 'models': [{'id': 'test'}]}]}
        with patch.object(gh, 'branch_snapshot', return_value=before), patch.object(module, 'catalog', return_value=catalog), patch.object(module, 'provider_text', return_value=json.dumps({'title': 'feat(ui): add feature', 'body': '## Validation\nNot run.'})) as provider:
            self.assertEqual(module.generate_pr(request)['title'], 'feat(ui): add feature')
            prompt = provider.call_args.args[2]
            self.assertIn(request['instructions'], prompt); self.assertIn('## Validation', prompt); self.assertIn('committed diff', prompt)
        with patch.object(gh, 'branch_snapshot', side_effect=[before, before, {**before, 'fingerprint': 'changed'}]), patch.object(module, 'catalog', return_value=catalog), patch.object(module, 'provider_text', return_value='{"title":"Title","body":"Body"}'):
            with self.assertRaisesRegex(ValueError, 'changed during generation'): module.generate_pr(request)
        for output in ['{}', '{"title":"bad\\ntitle","body":"Body"}', '{"title":"Title","body":null}', 'not json']:
            with patch.object(gh, 'branch_snapshot', return_value=before), patch.object(module, 'catalog', return_value=catalog), patch.object(module, 'provider_text', return_value=output):
                with self.assertRaises(ValueError): module.generate_pr(request)


if __name__ == '__main__':
    unittest.main()
