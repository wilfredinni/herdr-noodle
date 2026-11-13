#!/usr/bin/env python3
"""Install Noodle without replacing existing Herdr layouts or mods."""
import argparse
import json
import os
from pathlib import Path
import shutil

ROOT = Path(__file__).resolve().parent


def install(home):
    home = Path(home).expanduser()
    manifest = json.loads((ROOT / 'manifest.json').read_text())
    relatives = [Path('layouts/noodle.json'), Path('layouts/noodle.png')]
    relatives += [Path('mods') / name for name in manifest['mods']]
    conflicts = [str(home / p) for p in relatives if (home / p).exists() or (home / p).is_symlink()]
    if conflicts:
        raise FileExistsError('Nothing installed. These names already exist; rename the incoming layout/mods and their references first:\n' + '\n'.join(conflicts))
    created = []
    try:
        for relative in relatives:
            source, target = ROOT / relative, home / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            if source.is_dir():
                target.mkdir()
                created.append(target)
                shutil.copytree(source, target, dirs_exist_ok=True, ignore=shutil.ignore_patterns("__pycache__", "*.pyc", ".DS_Store"))
            else:
                with target.open('xb') as output:
                    created.append(target)
                    with source.open('rb') as input:
                        shutil.copyfileobj(input, output)
    except Exception:
        for target in reversed(created):
            if target.is_dir():
                shutil.rmtree(target)
            else:
                target.unlink()
        raise
    return relatives


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--home', default=os.environ.get('HERDR_APP_HOME', '~/.config/herdr-app'), help='Herdr configuration folder')
    args = parser.parse_args()
    try:
        installed = install(args.home)
    except (OSError, ValueError) as error:
        parser.exit(1, str(error) + '\n')
    print(f'Installed {len(installed)} layout/mod entries. Your settings and workspaces were preserved.')
    print('Activate: herdr-app do layout.switch \'{"name":"noodle"}\'')
