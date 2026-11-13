"""Read-only CLI adapters. Only normalized usage and connection metadata leave this process."""
import json, math, os, selectors, shutil, subprocess, sys, tempfile, time


def number(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) and value >= 0


def window(label, percent, reset=None, minutes=None):
    if not number(percent) or percent > 100:
        raise ValueError('Invalid quota percentage')
    return dict(label=str(label)[:80], usedPercent=percent,
                resetsAt=reset if number(reset) and reset > 0 else None,
                minutes=minutes if number(minutes) else None)


def read_json(text):
    try:
        return json.loads(text)
    except ValueError:
        decoder = json.JSONDecoder()
        for line in text.splitlines():
            if line.startswith(('{', '[')):
                try:
                    return decoder.raw_decode(text[text.index(line):])[0]
                except ValueError:
                    pass
        raise ValueError('The CLI returned an unsupported response')


def command(binary, args, seconds=15, data=None):
    with tempfile.TemporaryDirectory(prefix='herdr-usage-') as cwd:
        result = subprocess.run([binary, *args], input=data, capture_output=True, text=True, cwd=cwd, timeout=seconds)
    if result.returncode:
        raise ValueError('The CLI could not read usage. Check its sign-in and version.')
    if len(result.stdout) > 2_000_000:
        raise ValueError('Usage response is too large')
    return result.stdout


def codex(binary):
    with tempfile.TemporaryDirectory(prefix='herdr-usage-') as cwd:
        proc = subprocess.Popen([binary, 'app-server', '--stdio'], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                stderr=subprocess.DEVNULL, cwd=cwd)
        selector = selectors.DefaultSelector()
        selector.register(proc.stdout, selectors.EVENT_READ)
        buffer = b''

        def send(method, id=None, params=None):
            data = dict(method=method)
            if id is not None:
                data['id'] = id
            if params is not None:
                data['params'] = params
            proc.stdin.write((json.dumps(data) + '\n').encode())
            proc.stdin.flush()

        def read(id):
            nonlocal buffer
            deadline = time.monotonic() + 12
            while time.monotonic() < deadline:
                while b'\n' in buffer:
                    line, buffer = buffer.split(b'\n', 1)
                    try:
                        reply = json.loads(line)
                    except ValueError:
                        continue
                    if reply.get('id') == id:
                        if 'error' in reply:
                            raise ValueError('Codex could not read account usage. Check its sign-in.')
                        return reply.get('result', {})
                if not selector.select(max(0, deadline - time.monotonic())):
                    break
                part = os.read(proc.stdout.fileno(), 65536)
                if not part:
                    break
                buffer += part
                if len(buffer) > 2_000_000:
                    raise ValueError('Codex response is too large')
            raise TimeoutError('Codex usage request timed out')

        try:
            send('initialize', 0, {'clientInfo': {'name': 'herdr_usage', 'title': 'Herdr Usage', 'version': '0.1.0'}})
            read(0)
            send('initialized', params={})
            send('account/read', 1, {'refreshToken': False})
            account = read(1).get('account') or {}
            if not account:
                return dict(state='unavailable', mode='unknown', authenticated=False, note='Sign in with codex login.')
            mode = 'subscription' if account.get('type') in ('chatgpt', 'chatgptAuthTokens') else 'api'
            out = dict(state='ok', mode=mode, authenticated=True, plan=account.get('planType'), windows=[], source='codex app-server')
            if mode == 'api':
                out['note'] = 'Codex does not expose API billing. Check your provider dashboard.'
                return out
            send('account/rateLimits/read', 2)
            limits = read(2)
            buckets = limits.get('rateLimitsByLimitId') or {'codex': limits.get('rateLimits', {})}
            for id, bucket in sorted(buckets.items(), key=lambda item: item[0] != 'codex'):
                for slot in ('primary', 'secondary'):
                    item = bucket.get(slot)
                    if not item or item.get('usedPercent') is None:
                        continue
                    mins = item.get('windowDurationMins')
                    label = {300: '5h', 10080: '7d'}.get(mins, f'{mins}m' if number(mins) else slot)
                    if id != 'codex':
                        label = str(bucket.get('limitName') or id)[:50] + ' · ' + label
                    out['windows'].append(window(label, item['usedPercent'], item.get('resetsAt'), mins))
            if not out['windows']:
                out['note'] = 'No subscription quota returned by Codex.'
            return out
        finally:
            selector.close()
            try:
                proc.stdin.close()
            except BrokenPipeError:
                pass
            try:
                proc.wait(timeout=1)
            except subprocess.TimeoutExpired:
                proc.terminate()
                try:
                    proc.wait(timeout=1)
                except subprocess.TimeoutExpired:
                    proc.kill()
                    proc.wait()
            proc.stdout.close()


def claude(binary):
    # get_usage is an internal Claude interface; an unknown version fails without a model prompt.
    request = json.dumps({'type': 'control_request', 'request_id': 'herdr-usage',
                          'request': {'subtype': 'get_usage', 'skip_behaviors': True}}) + '\n'
    try:
        text = command(binary, ['-p', '--safe-mode', '--no-session-persistence', '--input-format', 'stream-json',
                                '--output-format', 'stream-json', '--verbose'], data=request)
    except subprocess.TimeoutExpired as error:
        text = error.stdout or b''
        if isinstance(text, bytes):
            text = text.decode('utf-8', errors='replace')
    response = next((json.loads(line).get('response', {}) for line in text.splitlines()
                     if line.startswith('{') and json.loads(line).get('type') == 'control_response'), None)
    if not response or response.get('subtype') != 'success':
        raise ValueError('This Claude version could not return usage. Check /usage in Claude.')
    body = response.get('response') or {}
    limits = body.get('rate_limits') or {}
    out = dict(state='ok', mode='subscription' if body.get('subscription_type') else 'unknown',
               authenticated=True, plan=body.get('subscription_type'), windows=[], source='claude get_usage')
    entries = limits.get('limits')
    if isinstance(entries, list):
        for item in entries:
            if item.get('percent') is None:
                continue
            kind = item.get('kind', '')
            scope = item.get('scope') or {}
            label = {'session': '5h', 'weekly_all': '7d'}.get(kind, (scope.get('model') or {}).get('display_name') or scope.get('surface') or kind)
            out['windows'].append(window(label, item['percent'], epoch(item.get('resets_at'))))
    else:
        for key, label in [('five_hour', '5h'), ('seven_day', '7d')]:
            item = limits.get(key) or {}
            if item.get('utilization') is not None:
                out['windows'].append(window(label, item['utilization'], epoch(item.get('resets_at'))))
    if not out['windows']:
        out['note'] = 'No subscription quota returned. API billing is available in your provider dashboard.'
    return out


def epoch(value):
    if number(value):
        return value
    if isinstance(value, str):
        from datetime import datetime
        try:
            return datetime.fromisoformat(value.replace('Z', '+00:00')).timestamp()
        except ValueError:
            pass
    return None


def auth_modes(accounts):
    modes = {}
    if not isinstance(accounts, list):
        return modes
    for account in accounts:
        provider = account.get('id')
        methods = {c.get('method') for c in account.get('connections', [])}
        if not provider:
            continue
        if provider == 'opencode-go':
            modes[provider] = 'subscription'
        elif methods == {'oauth'}:
            modes[provider] = 'subscription'
        elif methods and methods <= {'key', 'api', 'apiKey'}:
            modes[provider] = 'api'
        else:
            modes[provider] = 'unknown'
    return modes


def spending(stats, modes):
    total, sessions, models = stats.get('cost'), stats.get('sessions'), stats.get('models')
    if not number(total) or not number(sessions) or not isinstance(models, list):
        raise ValueError('Unsupported OpenCode statistics format')
    api, subscription, unknown = 0, 0, 0
    for model in models:
        cost = model.get('cost')
        if not number(cost):
            raise ValueError('Invalid model cost')
        mode = modes.get((model.get('model') or {}).get('providerID'), 'unknown')
        if mode == 'api':
            api += cost
        elif mode == 'subscription':
            subscription += cost
        else:
            unknown += cost
    if abs(total - api - subscription - unknown) > 0.01:
        api, subscription, unknown = None, None, total
    return dict(apiEstimateUsd=None if unknown > 0 else api, subscriptionEquivalentUsd=subscription, unclassifiedUsd=unknown, sessions=sessions)


def go_limits(response):
    if not isinstance(response, dict) or 'data' not in response:
        raise ValueError('Unsupported OpenCode usage response')
    data = response['data']
    if data is None:
        return dict(state='unavailable', note='OpenCode Go is connected. Sign in to OpenCode Console to read its limits.'), []
    if not isinstance(data, dict):
        raise ValueError('Invalid OpenCode usage data')
    go = data.get('go')
    if not go:
        return dict(state='unavailable', note='The signed-in Console workspace returned no Go allowance.'), []
    windows = []
    for key, label, minutes in [('rolling', 'Go · 5h', 300), ('weekly', 'Go · 7d', 10080), ('monthly', 'Go · month', None)]:
        item = go.get(key)
        if not isinstance(item, dict) or not number(item.get('resetsAt')) or item['resetsAt'] <= 0:
            raise ValueError('Invalid Go quota meter')
        # OpenCode's native API uses milliseconds; Herdr quota records use seconds.
        windows.append(window(label, item.get('percent'), item['resetsAt'] / 1000, minutes))
    return dict(state='ok', checkedAt=time.time()), windows


def opencode(binary, directory=None):
    try:
        modes = auth_modes(read_json(command(binary, ['auth', 'list', '--format', 'json'])))
    except Exception:
        modes = {}
    today = spending(read_json(command(binary, ['stats', '--days', '0', '--cost', '--models', '--json'])), modes)
    week = spending(read_json(command(binary, ['stats', '--days', '7', '--cost', '--models', '--json'])), modes)
    kinds = set(modes.values())
    mode = 'mixed' if 'api' in kinds and 'subscription' in kinds else next(iter(kinds)) if len(kinds) == 1 else 'unknown'
    out = dict(state='ok', mode=mode, authenticated=None, source='opencode stats', spend=dict(today=today, week=week),
               accounts=[dict(provider=id, mode=mode) for id, mode in modes.items()],
               note='Local estimates, not invoices. Based on current account types.')
    if 'opencode-go' in modes or 'opencode' in modes:
        from urllib.parse import urlencode
        path = '/api/experimental/usage/limits'
        if directory:
            path += '?' + urlencode({'location[directory]': directory})
        try:
            go, windows = go_limits(read_json(command(binary, ['api', 'get', path], seconds=20)))
            if windows or 'opencode-go' in modes:
                out['go'], out['windows'] = go, windows
        except Exception:
            if 'opencode-go' in modes:
                out['go'] = dict(state='error', note='Go limits could not be read. Check the Console connection and OpenCode version.')
    return out


def kiro(binary):
    # shortcut: Kiro's /usage has no stable JSON schema; keep the account link until a tested schema is available.
    return dict(state='unavailable', mode='unknown', authenticated=None,
                note='Kiro is installed. Run /usage in Kiro for current credits; no structured usage source is configured.')


def collect(id, directory=None):
    choices = {'codex': ['codex'], 'claude': ['claude'], 'opencode': ['opencode'], 'kiro': ['kiro-cli', 'kiro']}
    if id not in choices:
        raise ValueError('Unknown connection')
    binary = next((shutil.which(name) for name in choices[id] if shutil.which(name)), None)
    if not binary:
        return dict(state='missing', mode='unknown', installed=False, authenticated=False, note='CLI not installed on this machine.')
    try:
        result = opencode(binary, directory) if id == "opencode" else globals()[id](binary)
        return dict(result, installed=True)
    except (subprocess.TimeoutExpired, TimeoutError):
        return dict(state='error', mode='unknown', installed=True, note='Usage request timed out. Retry or check the CLI.')
    except Exception:
        return dict(state='error', mode='unknown', installed=True, note='Could not read usage. Check the CLI sign-in and version.')


if __name__ == '__main__':
    try:
        print(json.dumps(dict(collect(sys.argv[1], sys.argv[2] if len(sys.argv) > 2 and sys.argv[2] else None), checkedAt=time.time())))
    except Exception:
        print(json.dumps(dict(state='error', mode='unknown', note='Usage collector failed.', checkedAt=time.time())))
