"""Review text conflicts and apply an explicitly confirmed resolution."""
import hashlib
import json
import os
import re
import stat
import subprocess
import sys


def resolve(data, choice):
    output, ours, theirs, state, width, count = [], [], [], 'plain', 0, 0
    for line in data.splitlines(keepends=True):
        start = re.match(rb'^(<{3,})(?: |\r?$)', line)
        if start:
            if state != 'plain':
                raise ValueError('Nested conflict markers; resolve this file manually.')
            width = len(start[1]); state = 'ours'; ours = []; theirs = []; count += 1
        elif width and line.rstrip(b'\r\n') == b'|' * width + b' base':
            if state != 'ours':
                raise ValueError('Malformed conflict markers; resolve this file manually.')
            state = 'base'
        elif width and line.startswith(b'|' * width) and state == 'ours':
            state = 'base'
        elif width and line.rstrip(b'\r\n') == b'=' * width:
            if state not in ('ours', 'base'):
                raise ValueError('Malformed conflict markers; resolve this file manually.')
            state = 'theirs'
        elif width and line.startswith(b'>' * width):
            if state != 'theirs':
                raise ValueError('Malformed conflict markers; resolve this file manually.')
            output.extend(ours if choice == 'ours' else theirs if choice == 'theirs' else ours + theirs)
            state = 'plain'; width = 0
        elif state == 'plain':
            if re.match(rb'^[<=>|]{7}(?: |\r?$)', line):
                raise ValueError('Malformed conflict markers; resolve this file manually.')
            output.append(line)
        elif state == 'ours':
            ours.append(line)
        elif state == 'theirs':
            theirs.append(line)
    if state != 'plain':
        raise ValueError('Incomplete conflict markers; resolve this file manually.')
    if choice != 'resolved' and not count:
        raise ValueError('No text conflict markers found. Review the source and mark it resolved manually.')
    if choice == 'resolved' and count:
        raise ValueError('Conflict markers remain. Resolve them before marking this file resolved.')
    return b''.join(output), count


def main():
    root, relative, action = sys.argv[1:4]
    root = os.path.realpath(root)
    if os.path.isabs(relative) or '..' in relative.replace('\\', '/').split('/') or '\0' in relative:
        raise ValueError('Invalid conflict path')
    path = os.path.join(root, relative)
    if os.path.commonpath([root, os.path.realpath(path)]) != root or os.path.islink(path):
        raise ValueError('Refusing to resolve a symlink or a file outside the repository')
    def git(*args):
        return subprocess.check_output(['git', '--literal-pathspecs', '--no-optional-locks', '-c', 'core.fsmonitor=false', *args], cwd=root)
    stages = git('ls-files', '--unmerged', '-z', '--', relative)
    if not stages:
        raise ValueError('This file is no longer conflicted. Refresh the preview.')
    flags = os.O_RDONLY if action == 'inspect' else os.O_RDWR
    if hasattr(os, 'O_NOFOLLOW'):
        flags |= os.O_NOFOLLOW
    with os.fdopen(os.open(path, flags), 'rb' if action == 'inspect' else 'r+b') as file:
        if not stat.S_ISREG(os.fstat(file.fileno()).st_mode):
            raise ValueError('Only regular text files can be resolved here')
        data = file.read(400001)
        if len(data) > 400000 or b'\0' in data:
            raise ValueError('This conflict needs an external editor: binary or larger than 400,000 bytes')
        signature = hashlib.sha256(data + b'\0' + stages).hexdigest()
        if action == 'inspect':
            # A manual resolution can have no markers left while the index is still unmerged.
            _, count = resolve(data, 'both' if re.search(rb'^<{3,} ', data, re.M) else 'resolved')
            print(json.dumps({'signature': signature, 'count': count}))
            return
        expected, head, branch = sys.argv[4:7]
        actual_branch = subprocess.run(['git', 'symbolic-ref', '--quiet', 'HEAD'], cwd=root, capture_output=True)
        if actual_branch.returncode not in (0, 1):
            raise ValueError('Cannot verify the current branch')
        if git('rev-parse', 'HEAD').decode().strip() != head or actual_branch.stdout.decode().strip().removeprefix('refs/heads/') != branch:
            raise ValueError('The branch changed. Review the conflict again.')
        if signature != expected:
            raise ValueError('The conflict changed. Reopen the review before applying a resolution.')
        if action not in ('ours', 'theirs', 'both', 'resolved'):
            raise ValueError('Invalid resolution')
        resolved, _ = resolve(data, action)
        if action != 'resolved':
            file.seek(0); file.write(resolved); file.truncate(); file.flush(); os.fsync(file.fileno())
    git('add', '--', relative)
    print('Resolved and staged')


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        sys.exit(str(error))
