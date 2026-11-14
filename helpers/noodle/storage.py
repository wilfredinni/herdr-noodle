"""Private local state and path checks shared by Noodle's native panels."""
import contextlib
import hashlib
import json
import os
from pathlib import Path
import stat
import tempfile

LIMIT = 1024 * 1024


def state_home(request):
    home = Path(request['home']).expanduser().absolute() / 'data' / 'noodle'
    home.mkdir(mode=0o700, parents=True, exist_ok=True)
    if home.is_symlink():
        raise ValueError('Noodle state cannot be a symbolic link')
    home.chmod(0o700)
    return home


@contextlib.contextmanager
def locked(home):
    import fcntl
    flags = os.O_RDWR | os.O_CREAT | getattr(os, 'O_NOFOLLOW', 0)
    with os.fdopen(os.open(home / '.lock', flags, 0o600), 'r+') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        yield


def atomic(path, data, mode=0o600):
    path = Path(path)
    path.parent.mkdir(parents=True, mode=0o700, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix='.noodle-', dir=path.parent)
    try:
        with os.fdopen(fd, 'wb') as file:
            os.fchmod(file.fileno(), mode)
            file.write(data)
            file.flush()
            os.fsync(file.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def read_json(path, default=None):
    try:
        return json.loads(Path(path).read_text())
    except FileNotFoundError:
        return default


def write_json(path, value):
    atomic(path, json.dumps(value, ensure_ascii=False).encode())


def resolve(request, field='path', allow_root=False):
    root = Path(request['root']).expanduser().resolve(strict=True)
    relative = request.get(field, '')
    if not isinstance(relative, str) or '\0' in relative or Path(relative).is_absolute() or '..' in Path(relative).parts:
        raise ValueError('Choose a path inside this folder')
    if '.git' in Path(relative).parts:
        raise ValueError('Git metadata cannot be changed here')
    path = root / relative
    if not relative or path == root:
        if allow_root:
            return root, root
        raise ValueError('The project root cannot be changed here')
    parent = path.parent.resolve(strict=True)
    if not parent.is_relative_to(root):
        raise ValueError('The path leaves the selected folder')
    if '.git' in (parent / path.name).relative_to(root).parts:
        raise ValueError('Git metadata cannot be changed here')
    return root, parent / path.name


def fingerprint(path):
    try:
        value = Path(path).lstat()
    except FileNotFoundError:
        return None
    return [value.st_dev, value.st_ino, value.st_size, value.st_mtime_ns, value.st_mode]


def text(path):
    with open(path, 'rb') as file:
        data = file.read(LIMIT + 1)
    if len(data) > LIMIT:
        raise ValueError('Editing is limited to complete text files up to 1 MiB')
    if b'\0' in data:
        raise ValueError('Binary files cannot be edited here')
    try:
        return data.decode('utf-8')
    except UnicodeDecodeError:
        raise ValueError('Only UTF-8 text files can be edited here') from None


def save_text(path, value, expected):
    if len(value.encode()) > LIMIT or '\0' in value:
        raise ValueError('Editing is limited to complete UTF-8 text files up to 1 MiB')
    if Path(path).is_symlink():
        raise ValueError('Edit the link target directly instead')
    before = fingerprint(path)
    current = text(path)
    if current != expected:
        raise ValueError('The file changed outside Herdr. Your draft is preserved.')
    mode = stat.S_IMODE(Path(path).stat().st_mode)
    # A second check catches edits while reading; native writeTextFile is used for interactive saves.
    if fingerprint(path) != before or text(path) != expected:
        raise ValueError('The file changed outside Herdr. Your draft is preserved.')
    atomic(path, value.encode(), mode)


def identity(path):
    return hashlib.sha256(str(path).encode()).hexdigest()
