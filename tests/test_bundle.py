import json
from pathlib import Path
import re
import unittest

ROOT = Path(__file__).resolve().parents[1]



class BundleTests(unittest.TestCase):
    def test_bundle_has_the_six_mods_and_documentation(self):
        manifest = json.loads((ROOT/'manifest.json').read_text())
        self.assertEqual(set(manifest['mods']), {p.name for p in (ROOT/'mods').iterdir()})
        for name in ['README.md', 'RECIPE.md', 'NOTICE.md', 'preview.png', 'layouts/noodle.png']:
            self.assertTrue((ROOT/name).is_file(), name)
        self.assertEqual((ROOT/'preview.png').read_bytes(), (ROOT/'layouts/noodle.png').read_bytes())
        self.assertTrue((ROOT/'preview.png').read_bytes().startswith(b'\x89PNG\r\n\x1a\n'))

    def test_every_layout_mod_is_included_or_shipped(self):
        manifest = json.loads((ROOT/'manifest.json').read_text())
        allowed = set(manifest['mods'] + manifest['shippedMods'])
        def visit(value):
            if isinstance(value, dict):
                if 'mod' in value:
                    self.assertIn(value['mod'], allowed)
                for child in value.values():
                    visit(child)
            elif isinstance(value, list):
                for child in value:
                    visit(child)
        layout = json.loads((ROOT/'layouts/noodle.json').read_text())
        visit(layout)
        self.assertTrue((ROOT/layout['preview']).is_file())

    def test_relative_imports_and_mod_assets_resolve(self):
        manifest = json.loads((ROOT/'manifest.json').read_text())
        allowed = set(manifest['mods'] + manifest['shippedMods'])
        for file in (ROOT/'mods').rglob('*.js'):
            source = file.read_text()
            for name in re.findall(r'from\s+["\'](\.[^"\']+)["\']', source):
                self.assertTrue((file.parent/name).is_file(), f'{file}: {name}')
            for name in re.findall(r'mods/([^/]+)/', source):
                self.assertIn(name, allowed, f'{file}: {name}')

    def test_no_runtime_or_machine_files_were_packaged(self):
        forbidden = {'settings.json', 'shared.json', 'view.json', 'keys.json', 'auth.json', 'gpui-kit.d.ts', 'jsconfig.json', '.DS_Store'}
        for file in (ROOT/'mods').rglob('*'):
            if '__pycache__' in file.parts or file.name in {'gpui-kit.d.ts', 'jsconfig.json'}:
                continue
            self.assertNotIn(file.name, forbidden)
            self.assertFalse(file.is_symlink())
            if file.is_file():
                self.assertNotIn('/Users/carlosmontecinos/', file.read_text())



if __name__ == '__main__':
    unittest.main()
