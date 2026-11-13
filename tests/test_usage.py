import importlib.util
import json
from pathlib import Path
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location(
    'usage_collector', Path(__file__).resolve().parents[1] / 'mods/workspace-usage/collect.py')
collector = importlib.util.module_from_spec(spec)
spec.loader.exec_module(collector)


class OpenCodeUsageTests(unittest.TestCase):
    def test_reads_only_connections_and_project_quotas(self):
        accounts = [{'id': 'opencode-go', 'connections': [{'method': 'key'}]}]
        allowance = {'data': {'go': {key: {'percent': 12, 'resetsAt': 2000000000000}
                                   for key in ['rolling', 'weekly', 'monthly']}}}
        with patch.object(collector, 'command', side_effect=[json.dumps(accounts), json.dumps(allowance)]) as command:
            result = collector.opencode('opencode', '/project with spaces')
        self.assertEqual(command.call_count, 2)
        self.assertEqual(command.call_args_list[0].args[1], ['auth', 'list', '--format', 'json'])
        self.assertIn('location%5Bdirectory%5D=%2Fproject+with+spaces', command.call_args_list[1].args[1][2])
        self.assertEqual(len(result['windows']), 3)
        self.assertNotIn('spend', result)
        self.assertTrue(result['authenticated'])

    def test_sign_out_clears_usage_without_requesting_quotas(self):
        with patch.object(collector, 'command', return_value='[]') as command:
            result = collector.opencode('opencode')
        command.assert_called_once()
        self.assertFalse(result['authenticated'])

    def test_auth_failure_is_reported_instead_of_becoming_sign_out(self):
        with patch.object(collector.shutil, 'which', return_value='opencode'), \
                patch.object(collector, 'command', side_effect=ValueError('unavailable')):
            result = collector.collect('opencode')
        self.assertEqual(result['state'], 'error')
        self.assertNotIn('authenticated', result)

    def test_invalid_connections_do_not_become_sign_out(self):
        with patch.object(collector, 'command', return_value='{}'), self.assertRaises(ValueError):
            collector.opencode('opencode')


if __name__ == '__main__':
    unittest.main()
