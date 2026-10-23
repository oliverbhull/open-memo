"""Start one independent local runtime, serialized across concurrent clients."""
import fcntl
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import time
from .client import SpeechClient, DEFAULT_SOCKET
from .models import verify, MANIFEST
from . import __version__


def runtime_socket():
    """Bundled Memo owns its socket; external clients retain their explicit route."""
    override = os.getenv('CONOMO_SOCKET')
    if override:
        return Path(override).expanduser()
    if not os.getenv('CONOMO_MODEL_DIR'):
        return Path(DEFAULT_SOCKET)
    # Code and model identity isolate updates as well as development services.
    identity = hashlib.sha256(MANIFEST.read_bytes())
    for source in sorted(Path(__file__).parent.glob('*.py')):
        identity.update(source.name.encode())
        identity.update(source.read_bytes())
    return Path.home() / 'Library/Application Support/Memo/asr' / (identity.hexdigest()[:16] + '.sock')


def ensure_running():
    socket = runtime_socket()
    os.environ['CONOMO_SOCKET'] = str(socket)
    model = os.getenv('CONOMO_MODEL_DIR')
    if not model:
        # External services are allowed; the caller then owns their lifecycle.
        return
    model = Path(model).expanduser().resolve()
    revision = json.loads(MANIFEST.read_text())['revision']
    socket.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    with open(str(socket) + '.startup.lock', 'a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        try:
            with SpeechClient(str(socket), source='status', timeout=1) as client:
                if client.info.get('runtime') != 'Conomo':
                    raise RuntimeError('Another runtime owns the Conomo socket')
                if client.info.get('model_revision') != revision or client.info.get('runtime_version') != __version__:
                    raise RuntimeError('Conomo runtime or model version changed; restart the runtime before dictating')
                return
        except (OSError, ConnectionError):
            pass
        verify(model)
        logs = Path.home() / 'Library/Logs/Conomo'
        logs.mkdir(parents=True, exist_ok=True, mode=0o700)
        with (logs/'runtime.log').open('ab') as output:
            process = subprocess.Popen([sys.executable, '-B', '-m', 'conomo.server', '--model', str(model), '--socket', str(socket)],
                stdin=subprocess.DEVNULL, stdout=output, stderr=output, start_new_session=True)
        deadline = time.monotonic() + 120
        while time.monotonic() < deadline:
            if process.poll() is not None:
                raise RuntimeError(f'Conomo exited during startup; see {logs / "runtime.log"}')
            try:
                with SpeechClient(str(socket), source='status', timeout=1) as client:
                    if client.info.get('pid') != process.pid:
                        raise RuntimeError('Unexpected Conomo socket owner during startup')
                    return
            except (OSError, ConnectionError):
                time.sleep(.1)
        process.terminate()
        raise RuntimeError('Conomo startup timed out')
