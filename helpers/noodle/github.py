"""GitHub through the user's gh sign-in; network calls never hold the editor lock."""
import hashlib
import json
import os
from pathlib import Path
import re
import selectors
import subprocess
import tempfile
import time
import urllib.parse
import uuid
from concurrent.futures import ThreadPoolExecutor
from storage import read_json, resolve, write_json

READ = ['--no-optional-locks', '-c', 'core.fsmonitor=false', '--literal-pathspecs']


def command(args, root, data=None, timeout=25):
    try:
        result = subprocess.run(args, cwd=root, input=data, capture_output=True, text=True, timeout=timeout,
                                env={**os.environ, 'GH_PROMPT_DISABLED': '1', 'GIT_TERMINAL_PROMPT': '0'})
    except FileNotFoundError:
        raise ValueError('Install gh and run gh auth login to use GitHub.') from None
    except subprocess.TimeoutExpired:
        raise ValueError('GitHub timed out. Refresh to try again.') from None
    if result.returncode:
        raise ValueError(result.stderr.strip() or 'GitHub request failed. Check gh auth status and repository access.')
    return result.stdout


def git(root, *args):
    return command(['git', *READ, *args], root).strip()


def number(value):
    if not re.fullmatch(r'[1-9][0-9]{0,19}', str(value)):
        raise ValueError('Choose a valid GitHub item.')
    return str(value)


def repository(root):
    value = json.loads(command(['gh', 'repo', 'view', '--json', 'nameWithOwner,url,defaultBranchRef'], root))
    url = urllib.parse.urlsplit(value['url'])
    name = value['nameWithOwner']
    if url.scheme != 'https' or not url.hostname or not re.fullmatch(r'[\w.-]+/[\w.-]+', name):
        raise ValueError('GitHub returned an invalid repository.')
    return {**value, 'host': url.hostname, 'name': name, 'ref': url.hostname + '/' + name}


def api(root, repo, endpoint, fields=None):
    args = ['gh', 'api', '--hostname', repo['host'], endpoint]
    if fields:
        for key, value in fields.items():
            args += ['-f', key + '=' + str(value)]
    return json.loads(command(args, root))


def pages(root, repo, endpoint):
    values = []
    # Every nested collection is paginated as well; never label a capped export complete.
    for page in range(1, 101):
        value = api(root, repo, endpoint + ('&' if '?' in endpoint else '?') + f'per_page=100&page={page}')
        values.extend(value)
        if len(value) < 100:
            return values
    raise ValueError('This collection exceeds 10,000 items. Open it on GitHub for the complete list.')


def pull(root, repo, n):
    return api(root, repo, f'repos/{repo["name"]}/pulls/{number(n)}')


def threads(root, repo, n):
    owner, name = repo['name'].split('/')
    cursor, values = None, []
    for _ in range(100):
        query = '''query($owner:String!,$name:String!,$n:Int!,$after:String) {
          repository(owner:$owner,name:$name) { pullRequest(number:$n) {
            reviewThreads(first:100,after:$after) { pageInfo { hasNextPage endCursor }
              nodes { id path line originalLine diffSide isResolved isOutdated
                comments(first:100) { pageInfo { hasNextPage endCursor }
                  nodes { id body url createdAt author { login } } } } } } } }'''
        args = ['gh', 'api', '--hostname', repo['host'], 'graphql', '-f', 'query=' + query,
                '-f', 'owner=' + owner, '-f', 'name=' + name, '-F', 'n=' + number(n)]
        if cursor:
            args += ['-f', 'after=' + cursor]
        result = json.loads(command(args, root))
        if result.get('errors'):
            raise ValueError('GitHub could not load complete review threads. Refresh or open the PR on GitHub.')
        collection = result['data']['repository']['pullRequest']['reviewThreads']
        for thread in collection['nodes']:
            comments = thread['comments']
            count = 0
            while comments['pageInfo']['hasNextPage']:
                count += 1
                if count > 100:
                    raise ValueError('This thread is too large to extract completely. Open it on GitHub.')
                query = '''query($id:ID!,$after:String!) { node(id:$id) { ... on PullRequestReviewThread {
                  comments(first:100,after:$after) { pageInfo { hasNextPage endCursor }
                    nodes { id body url createdAt author { login } } } } } }'''
                response = api(root, repo, 'graphql', {'query': query, 'id': thread['id'], 'after': comments['pageInfo']['endCursor']})
                if response.get('errors'):
                    raise ValueError('GitHub could not load all thread replies. Refresh to try again.')
                extra = response['data']['node']['comments']
                comments['nodes'].extend(extra['nodes'])
                comments['pageInfo'] = extra['pageInfo']
            thread['comments'] = comments['nodes']
            values.append(thread)
        if not collection['pageInfo']['hasNextPage']:
            return values
        cursor = collection['pageInfo']['endCursor']
    raise ValueError('This PR is too large to extract completely. Open it on GitHub.')


def detail(root, repo, n):
    pr = pull(root, repo, n)
    with ThreadPoolExecutor(max_workers=3) as pool:
        checks = pool.submit(command, ['gh', 'pr', 'view', number(n), '-R', repo['ref'], '--json', 'statusCheckRollup,reviewDecision'], root)
        review_threads = pool.submit(threads, root, repo, n)
        reviews = pool.submit(pages, root, repo, f'repos/{repo["name"]}/pulls/{number(n)}/reviews')
        value = {**pr, **json.loads(checks.result()), 'threads': review_threads.result(), 'reviews': reviews.result()}
    if pull(root, repo, n)['head']['sha'] != pr['head']['sha']:
        raise ValueError('The PR changed during refresh. Refresh again for its latest reviews and checks.')
    return value


def template(root, path):
    if not path:
        return ''
    if not isinstance(path, str) or '\0' in path:
        raise ValueError('Choose a readable PR template file.')
    file = Path(path).expanduser()
    if not file.is_absolute():
        file = root / file
        if not file.resolve(strict=True).is_relative_to(root.resolve()):
            raise ValueError('Use an explicit absolute path for a template outside this repository.')
    with file.open('rb') as stream:
        data = stream.read(1_048_577)
    if len(data) > 1_048_576 or b'\0' in data:
        raise ValueError('PR templates must be UTF-8 text up to 1 MiB.')
    try:
        return data.decode('utf-8')
    except UnicodeDecodeError:
        raise ValueError('PR templates must use UTF-8 text.') from None


def templates(root):
    result = []
    for directory in [root, root / '.github', root / 'docs']:
        if not directory.is_dir():
            continue
        for entry in sorted(directory.iterdir()):
            if entry.name.lower() == 'pull_request_template.md' and entry.is_file():
                result.append(str(entry.relative_to(root)))
            if entry.name.lower() == 'pull_request_template' and entry.is_dir():
                result.extend(str(p.relative_to(root)) for p in sorted(entry.glob('*.md')) if p.is_file())
    return result


def branch_snapshot(request):
    root = Path(request['root']).resolve(strict=True)
    head = git(root, 'rev-parse', 'HEAD')
    branch = git(root, 'symbolic-ref', '--short', 'HEAD')
    if head != request['head'] or branch != request['branch']:
        raise ValueError('The branch changed. Reopen the PR composer.')
    base = request.get('base', '')
    if not isinstance(base, str) or base.startswith('-') or not base or '\0' in base:
        raise ValueError('Choose a base branch.')
    repo = repository(root)
    commit = api(root, repo, f'repos/{repo["name"]}/commits/{urllib.parse.quote(base, safe="")}')['sha']
    try:
        merge = git(root, 'merge-base', head, commit)
    except ValueError:
        raise ValueError('Fetch the base branch before generating this PR.') from None
    diff = command(['git', *READ, 'diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--unified=1', merge, head, '--'], root)
    commits = command(['git', *READ, 'log', '--format=%s%n%b', merge + '..' + head, '--'], root)
    body = template(root, request.get('template', ''))
    payload = f'Branch: {branch}\nBase: {base}\nCommits:\n{commits}\nDiff:\n{diff}'
    if len(payload.encode()) > 1_200_000:
        raise ValueError('The PR diff exceeds 1,200,000 bytes. Use a smaller branch or write the description manually.')
    if not diff:
        raise ValueError('This branch has no committed changes against the selected base.')
    fingerprint = hashlib.sha256(json.dumps([head, commit, branch, body, payload]).encode()).hexdigest()
    return {'payload': payload, 'template': body, 'fingerprint': fingerprint, 'head': head, 'repo': repo}


def existing(root, repo, branch, head):
    values = json.loads(command(['gh', 'pr', 'list', '-R', repo['ref'], '--head', branch, '--state', 'open',
                                 '--json', 'number,url,headRefOid,headRepositoryOwner,isCrossRepository', '--limit', '100'], root))
    owner = repo['name'].split('/')[0].lower()
    return next((p for p in values if p['headRefOid'] == head and not p.get('isCrossRepository')
                 and (p.get('headRepositoryOwner') or {}).get('login', owner).lower() == owner), None)


def create(request):
    root = Path(request['root']).resolve(strict=True)
    if git(root, 'rev-parse', 'HEAD') != request['head'] or git(root, 'symbolic-ref', '--short', 'HEAD') != request['branch']:
        raise ValueError('The branch changed. Reopen the PR composer.')
    repo = repository(root)
    branch = request['branch']
    remote = api(root, repo, f'repos/{repo["name"]}/git/ref/heads/{urllib.parse.quote(branch, safe="")}')
    if remote['object']['sha'] != request['head']:
        raise ValueError('Publish or push this branch before creating the PR.')
    prior = existing(root, repo, branch, request['head'])
    if prior:
        return {'url': prior['url'], 'number': prior['number'], 'existing': True}
    title, body, base = request.get('title'), request.get('body'), request.get('base')
    if not isinstance(title, str) or not title.strip() or len(title) > 256 or any(ord(c) < 32 for c in title):
        raise ValueError('Write a single-line PR title of at most 256 characters.')
    if not isinstance(body, str) or len(body) > 65536 or '\0' in body:
        raise ValueError('PR descriptions must contain at most 65,536 characters without null characters.')
    if not isinstance(base, str) or not base or base.startswith('-') or '\0' in base:
        raise ValueError('Choose a base branch.')
    with tempfile.TemporaryDirectory(prefix='herdr-pr-') as directory:
        file = Path(directory) / 'body.md'
        file.write_text(body); file.chmod(0o600)
        args = ['gh', 'pr', 'create', '-R', repo['ref'], '--head', branch, '--base', base,
                '--title', title.strip(), '--body-file', str(file)]
        if request.get('draft'):
            args.append('--draft')
        try:
            url = command(args, root).strip()
        except ValueError as error:
            try:
                found = existing(root, repo, branch, request['head'])
            except ValueError:
                raise ValueError('Creation outcome is unknown. Refresh PRs on GitHub before retrying.') from None
            if found:
                return {'url': found['url'], 'number': found['number'], 'existing': True}
            raise error
    return {'url': url}


def log(root, repo, run, job=None, failed=False):
    n = number(run)
    info = api(root, repo, f'repos/{repo["name"]}/actions/runs/{n}')
    if (info.get('repository') or {}).get('full_name', '').lower() != repo['name'].lower():
        raise ValueError('This run does not belong to the selected repository.')
    args = ['gh', 'run', 'view', n, '-R', repo['ref']]
    if job:
        value = api(root, repo, f'repos/{repo["name"]}/actions/jobs/{number(job)}')
        if str(value['run_id']) != n:
            raise ValueError('This job does not belong to the selected run.')
        args += ['--job', str(job)]
    args += ['--log-failed' if failed else '--log']
    process = subprocess.Popen(args, cwd=root, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    selector = selectors.DefaultSelector(); selector.register(process.stdout, selectors.EVENT_READ)
    started, tail, total = time.monotonic(), b'', 0
    try:
        while time.monotonic() - started < 25:
            if not selector.select(.1):
                if process.poll() is not None:
                    break
                continue
            chunk = process.stdout.read1(65536)
            if not chunk:
                break
            total += len(chunk); tail = (tail + chunk)[-200000:]
        else:
            raise ValueError('Logs timed out. Open this run on GitHub for the full log.')
    finally:
        selector.close()
        if process.poll() is None:
            process.terminate()
        process.wait(timeout=2); process.stdout.close()
    if process.returncode:
        raise ValueError('Logs are not available yet, or have expired. Open the run on GitHub.')
    return {'text': tail.decode('utf-8', 'replace'), 'head': info['head_sha'], 'truncated': total > 200000}


def handle(action, request, home):
    root, _ = resolve({**request, 'path': ''}, allow_root=True)
    if action == 'github_prepare':
        token = uuid.uuid4().hex
        file = home / 'github' / (token + '.json')
        write_json(file, {})
        return {'token': token, 'path': str(file)}
    if action in ('github_create', 'github_generate'):
        token = request.get('token', '')
        if not re.fullmatch(r'[a-f0-9]{32}', token):
            raise ValueError('Reopen the PR composer.')
        file = home / 'github' / (token + '.json')
        try:
            if file.is_symlink() or file.stat().st_size > 1_500_000:
                raise ValueError('The PR request is invalid. Reopen the composer.')
            data = read_json(file)
            if not isinstance(data, dict) or not isinstance(data.get('root'), str) or Path(data['root']).resolve() != root:
                raise ValueError('The PR request is invalid. Reopen the composer.')
            if action == 'github_create':
                return create(data)
            # Import only for generation; the module keeps the existing provider adapters.
            import importlib.util
            spec = importlib.util.spec_from_file_location('noodle_generate', Path(request['home']) / 'mods/changes-graph/generate.py')
            module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
            return module.generate_pr(data)
        finally:
            file.unlink(missing_ok=True)
    if action == 'github_template':
        return {'body': template(root, request.get('template', ''))}
    repo = repository(root)
    if action == 'github_branches':
        return {'items': [branch['name'] for branch in pages(root, repo, f'repos/{repo["name"]}/branches')]}
    if action == 'github_info':
        current = []
        if request.get('branch'):
            head = repo['name'].split('/')[0] + ':' + request['branch']
            current = api(root, repo, f'repos/{repo["name"]}/pulls?state=open&per_page=1&head={urllib.parse.quote(head, safe="")}')
        return {'repo': repo, 'templates': templates(root), 'current': current[0] if current else None}
    if action == 'github_ready':
        head = git(root, 'rev-parse', 'HEAD')
        branch = git(root, 'symbolic-ref', '--short', 'HEAD')
        ready = False
        try:
            ref = api(root, repo, f'repos/{repo["name"]}/git/ref/heads/{urllib.parse.quote(branch, safe="")}')
            ready = ref['object']['sha'] == head
        except ValueError as error:
            if '404' not in str(error) and 'Not Found' not in str(error):
                raise
        return {'ready': ready, 'head': head, 'branch': branch}
    page = int(number(request.get('page', 1)))
    if page > 1000:
        raise ValueError('Too many GitHub pages. Narrow the filter.')
    if action == 'github_prs':
        items = api(root, repo, f'repos/{repo["name"]}/pulls?state=open&sort=updated&direction=desc&per_page=50&page={page}')
        return {'items': items, 'more': len(items) == 50}
    if action == 'github_pr':
        return detail(root, repo, request['number'])
    if action == 'github_runs':
        branch = request.get('branch')
        query = '&branch=' + urllib.parse.quote(branch, safe='') if branch else ''
        value = api(root, repo, f'repos/{repo["name"]}/actions/runs?per_page=50&page={page}{query}')
        return {'items': value['workflow_runs'], 'more': len(value['workflow_runs']) == 50}
    if action == 'github_run':
        n = number(request['run'])
        info = api(root, repo, f'repos/{repo["name"]}/actions/runs/{n}')
        jobs = []
        for index in range(1, 101):
            value = api(root, repo, f'repos/{repo["name"]}/actions/runs/{n}/jobs?per_page=100&page={index}')['jobs']
            jobs.extend(value)
            if len(value) < 100:
                return {**info, 'jobs': jobs}
        raise ValueError('This run has too many jobs. Open it on GitHub.')
    if action == 'github_log':
        return log(root, repo, request['run'], request.get('job'), request.get('failed', False))
    if action == 'github_location':
        pr = pull(root, repo, request['number'])
        path = request.get('path', '')
        if not path or Path(path).is_absolute() or '..' in Path(path).parts or '\0' in path:
            raise ValueError('Invalid review location.')
        head = pr['head']['sha']
        if request.get('reviewedHead') and request['reviewedHead'] != head:
            raise ValueError('The PR changed. Refresh reviews before opening this location.')
        try:
            git(root, 'cat-file', '-e', head + '^{commit}')
        except ValueError:
            return {'local': False}
        return {'local': True, 'head': head, 'base': pr['base']['sha']}
    raise ValueError('Unknown GitHub operation.')
