"""Invoked only in a new Noodle task terminal; never wraps an agent terminal."""
import os
from pathlib import Path
import subprocess
import sys
import time
import signal
from storage import atomic, read_json, write_json

LIMIT = 2 * 1024 * 1024


def run(path):
    state = read_json(path)
    state.update(state='running', pid=os.getpid())
    write_json(path, state)
    log, tail = Path(path).with_suffix('.log'), b''
    code = 130
    child = None
    # The core delivers Ctrl-C to this task's foreground group, including its child.
    # Keep the wrapper alive if the child ignores it so Force stop remains available.
    signal.signal(signal.SIGINT, lambda _signum, _frame: None)
    try:
        child = subprocess.Popen(['/bin/sh', '-lc', state['command']], cwd=state['root'], stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        while True:
            block = child.stdout.read1(8192)
            if not block: break
            tail = (tail + block)[-LIMIT:]
            atomic(log, tail)
            os.write(1, block)
        code = child.wait()
    except KeyboardInterrupt:
        if child:
            try: child.wait(timeout=3)
            except subprocess.TimeoutExpired: pass
    finally:
        if child and child.stdout: child.stdout.close()
        state.update(state='passed' if code == 0 else 'interrupted' if code in [130, -2] else 'failed', code=code, ended=time.time())
        write_json(path, state)
        # Retain the newest 20 bounded logs per repository, including this run.
        logs = sorted(log.parent.glob('run-*.log'), key=lambda p: p.stat().st_mtime, reverse=True)
        for old in logs[20:]: old.unlink(missing_ok=True)
    return code

if __name__ == '__main__': sys.exit(run(sys.argv[1]))
