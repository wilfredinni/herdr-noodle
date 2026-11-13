import { exec } from "herdr";

export async function git(args, snapshot) {
  // Stash invokes Git internally; literal pathspec mode prevents its untracked cleanup.
  const result = await exec("git", [...(args[0] === "stash" ? [] : ["--literal-pathspecs"]), "-c", "core.fsmonitor=false", ...args], { cwd: snapshot.root, on: snapshot.on, timeout: 120000 });
  if (result.code !== 0) throw new Error((result.stderr || result.stdout || "Git operation failed").trim());
  return result.stdout;
}

export async function verify(snapshot) {
  const result = await exec("git", ["--no-optional-locks", "symbolic-ref", "--quiet", "HEAD"], { cwd: snapshot.root, on: snapshot.on });
  if (result.code !== 0 && result.code !== 1) throw new Error(result.stderr || "Cannot verify current branch");
  const branch = result.code === 0 ? result.stdout.trim().replace(/^refs\/heads\//, "") : null;
  const head = await exec("git", ["rev-parse", "--verify", "--quiet", "HEAD"], { cwd: snapshot.root, on: snapshot.on });
  if (head.code !== 0 && head.code !== 1) throw new Error(head.stderr || "Cannot verify HEAD");
  if (branch !== snapshot.branch || (head.code === 0 ? head.stdout.trim() : "") !== snapshot.head)
    throw new Error("The branch changed. Review the changes and try again.");
}

export function stage(paths, checked, snapshot) {
  if (paths && !paths.length) return Promise.resolve("");
  if (checked) return git(["add", "-A", "--", ...(paths ?? ["."])], snapshot);
  if (snapshot.hasHead) return git(["restore", "--staged", "--", ...(paths ?? ["."])], snapshot);
  return git(paths ? ["rm", "--cached", "--force", "--", ...paths] : ["read-tree", "--empty"], snapshot);
}

export async function stashes(snapshot) {
  const output = await git(["stash", "list", "--format=%H%x00%gd%x00%gs%x00%ct"], snapshot);
  return output.split("\n").filter(Boolean).map(line => {
    const [hash, ref, subject, time] = line.split("\0");
    return { hash, ref, subject, time: Number(time) };
  });
}

export async function popStash(hash, snapshot) {
  if (!/^[0-9a-f]{40,64}$/.test(hash)) throw new Error("Invalid stash selection");
  if ((await git(["rev-parse", "refs/stash"], snapshot)).trim() !== hash)
    throw new Error("The stash list changed. Reopen it before applying a stash.");
  return git(["stash", "pop", "--index", "stash@{0}"], snapshot);
}

export function ignorePattern(path) {
  if (!path || /[\r\n\0]/.test(path) || path.startsWith("/") || path.split("/").some(part => !part || part === "." || part === ".."))
    throw new Error("This filename cannot be represented safely in an ignore file");
  return "/" + path.replace(/[\\*?\[\] #!]/g, "\\$&");
}

const IGNORE_SCRIPT = `import os, sys, stat
target, pattern = sys.argv[1:]
flags = os.O_RDWR | os.O_APPEND | os.O_CREAT
if os.path.islink(os.path.dirname(target)): raise RuntimeError('Refusing to change a symlinked ignore directory')
os.makedirs(os.path.dirname(target), exist_ok=True)
if hasattr(os, 'O_NOFOLLOW'): flags |= os.O_NOFOLLOW
elif os.path.islink(target): raise RuntimeError('Refusing to change a symlinked ignore file')
fd = os.open(target, flags, 0o644)
with os.fdopen(fd, 'r+b') as file:
 if not stat.S_ISREG(os.fstat(file.fileno()).st_mode): raise RuntimeError('Ignore target is not a regular file')
 if os.name == 'posix':
  import fcntl
  fcntl.flock(file, fcntl.LOCK_EX)
 file.seek(0)
 data = file.read()
 line = pattern.encode('utf-8')
 if line not in data.splitlines():
  file.write((b'\\n' if data and not data.endswith(b'\\n') else b'') + line + b'\\n')
  file.flush()
  os.fsync(file.fileno())
`;

export async function addIgnore(path, local, snapshot) {
  const untracked = (await git(["ls-files", "--others", "--exclude-standard", "-z", "--", path], snapshot)).split("\0");
  if (!untracked.includes(path)) throw new Error("Only untracked files can be ignored");
  const target = local ? (await git(["rev-parse", "--path-format=absolute", "--git-path", "info/exclude"], snapshot)).replace(/\n$/, "") : `${snapshot.root}/.gitignore`;
  const result = await exec("python3", ["-c", IGNORE_SCRIPT, target, ignorePattern(path)], { cwd: snapshot.root, on: snapshot.on });
  if (result.code !== 0) throw new Error(result.stderr || "Cannot update the ignore file");
}

export const TRASH_SCRIPT = `import os, sys, shutil, uuid, datetime, urllib.parse
root = os.path.realpath(sys.argv[1])
if sys.platform == 'darwin':
 base = os.path.expanduser('~/.Trash'); files = base; info = None
elif sys.platform.startswith('linux'):
 base = os.path.join(os.environ.get('XDG_DATA_HOME', os.path.expanduser('~/.local/share')), 'Trash')
 files = os.path.join(base, 'files'); info = os.path.join(base, 'info')
else: raise RuntimeError('Recoverable Trash is available on macOS and Linux')
sources = []
for relative in sys.argv[2:]:
 if os.path.isabs(relative) or '..' in relative.split('/') or '\\0' in relative: raise RuntimeError('Invalid file path')
 source = os.path.join(root, relative)
 parent = os.path.realpath(os.path.dirname(source))
 if os.path.commonpath([root, parent]) != root: raise RuntimeError('File path escapes the repository')
 source = os.path.join(parent, os.path.basename(source))
 if os.path.isdir(source) and not os.path.islink(source): raise RuntimeError('Refusing to trash a directory')
 if os.path.lexists(source): sources.append(source)
os.makedirs(files, mode=0o700, exist_ok=True)
if info: os.makedirs(info, mode=0o700, exist_ok=True)
for source in sources:
 name = uuid.uuid4().hex[:12] + '-' + os.path.basename(source).encode('utf-8')[:200].decode('utf-8', 'ignore')
 target = os.path.join(files, name)
 if info:
  with open(os.path.join(info, name + '.trashinfo'), 'x') as file:
   file.write('[Trash Info]\\nPath=' + urllib.parse.quote(source, safe='/') + '\\nDeletionDate=' + datetime.datetime.now().strftime('%Y-%m-%dT%H:%M:%S') + '\\n')
 shutil.move(source, target)
`;

export async function trash(paths, snapshot, added = false) {
  const allowed = new Set((await git(["ls-files", "--others", "--exclude-standard", "-z"], snapshot)).split("\0").filter(Boolean));
  if (added) for (const path of (await git(["diff", "--cached", "--name-only", "--diff-filter=A", "-z"], snapshot)).split("\0").filter(Boolean)) allowed.add(path);
  const targets = paths ?? [...allowed];
  if (targets.some(path => !allowed.has(path))) throw new Error("File tracking changed. Review the file list before moving files to Trash.");
  if (!targets.length) return;
  const result = await exec("python3", ["-c", TRASH_SCRIPT, snapshot.root, ...targets], { cwd: snapshot.root, on: snapshot.on });
  if (result.code !== 0) throw new Error(result.stderr || "Cannot move files to Trash");
}
