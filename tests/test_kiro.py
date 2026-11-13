import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location(
    'usage_collector', Path(__file__).resolve().parents[1] / 'mods/workspace-usage/collect.py')
collector = importlib.util.module_from_spec(spec)
spec.loader.exec_module(collector)

REPORT = ('\x1b[32mEstimated Usage | resets on 2026-12-01 | KIRO POWER\x1b[0m\n'
          'Credits (1234.56 of 10000 covered in plan), 12.3%\n'
          "Overages: Disabled\nYour plan is managed by your organization's administrator.")


class KiroUsageTests(unittest.TestCase):
    def test_identity_center_report(self):
        reading = collector.kiro_usage(REPORT)
        self.assertEqual(reading['state'], 'ok')
        self.assertAlmostEqual(reading['windows'][0]['usedPercent'], 12.3456)
        self.assertEqual(reading['windows'][0]['resetsAt'], 1796083200)

    def test_uses_v2_slash_command(self):
        with patch.object(collector, 'command', return_value=REPORT) as command:
            self.assertEqual(collector.kiro('kiro-cli')['state'], 'ok')
        command.assert_called_once_with(
            'kiro-cli', ['chat', '--no-interactive', '/usage', '--v2'], seconds=40)

    def test_missing_or_invalid_usage_is_never_zero(self):
        for report in ['Not logged in', 'Plan: KIRO POWER | 1 usage breakdowns',
                       'resets on 2026-12-01 Credits (5 of 0 covered in plan)',
                       'resets on 2026-99-01 Credits (5 of 100 covered in plan)']:
            with self.subTest(report=report), self.assertRaises(ValueError):
                collector.kiro_usage(report)


if __name__ == '__main__':
    unittest.main()
