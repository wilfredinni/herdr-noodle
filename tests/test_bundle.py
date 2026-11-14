import json
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]



class BundleTests(unittest.TestCase):
    def test_file_views_keep_the_same_icon_mapping(self):
        # Herdr isolates module imports to each mod's directory.
        for mod in ['file-editor', 'git-file-preview']:
            self.assertEqual((ROOT/'mods'/mod/'fileIcons.js').read_bytes(),
                             (ROOT/'mods/files-browser/fileIcons.js').read_bytes())

    def test_bundle_has_the_declared_mods_and_documentation(self):
        manifest = json.loads((ROOT/'manifest.json').read_text())
        self.assertEqual(set(manifest['mods']), {p.name for p in (ROOT/'mods').iterdir()})
        for name in ['README.md', 'INSTALL.md', 'RECIPE.md', 'NOTICE.md', 'native/README.md', 'preview.png', manifest['preview']]:
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
        layout = json.loads((ROOT/manifest['layout']).read_text())
        visit(layout)
        self.assertEqual(layout['preview'], manifest['preview'])
        self.assertTrue((ROOT/layout['preview']).is_file())

    def test_fresh_manifest_install_opens_and_recovers_a_document(self):
        manifest = json.loads((ROOT/'manifest.json').read_text())
        entries = [manifest['layout'], manifest['preview'], *manifest['helpers'],
                   *(f'mods/{name}' for name in manifest['mods'])]
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary)/'herdr'
            for entry in entries:
                source, destination = ROOT/entry, home/entry
                if source.is_dir():
                    shutil.copytree(source, destination, ignore=shutil.ignore_patterns(
                        '__pycache__', '*.pyc', 'gpui-kit.d.ts', 'jsconfig.json'))
                else:
                    destination.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copyfile(source, destination)
            for file in (home/'mods').rglob('*.js'):
                for helper in re.findall(r'helpers/[\w-]+/[\w.-]+\.py', file.read_text()):
                    self.assertTrue((home/helper).is_file(), f'{file}: {helper}')
            project = Path(temporary)/'project'
            project.mkdir()
            file = project/'example.txt'
            original = b'\xef\xbb\xbf\tEspa\xc3\xb1ol\r\nno final newline'
            file.write_bytes(original)

            def call(action, **request):
                result = subprocess.run([
                    sys.executable, '-E', str(home/'helpers/noodle/workspace.py'), action,
                    json.dumps({'home': str(home), 'root': str(project), **request})
                ], cwd=home, capture_output=True, text=True, timeout=10)
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                return json.loads(result.stdout)

            document = call('document_open', path=file.name)
            self.assertEqual(document['draft'].encode(), original)
            draft = original + b'\r\nunsaved edit'
            Path(document['inputPath']).write_bytes(draft)
            call('document_checkpoint', id=document['id'])
            recovered = call('document_open', path=file.name)
            self.assertTrue(recovered['dirty'])
            self.assertEqual(recovered['draft'].encode(), draft)
            self.assertEqual(file.read_bytes(), original)

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
