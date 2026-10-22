"""Pinned, atomic model installation; never trust an unverified cache hit."""
import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import shutil
import tempfile
from urllib.request import urlopen

MANIFEST = Path(__file__).with_name('model-manifest.json')


def digest(path):
    h = hashlib.sha256()
    with path.open('rb') as f:
        for block in iter(lambda: f.read(1024 * 1024), b''):
            h.update(block)
    return h.hexdigest()


def verify(directory, manifest=None):
    manifest = manifest or json.loads(MANIFEST.read_text())
    for name, expected in manifest['files'].items():
        p = directory / name
        if Path(name).name != name or not p.is_file() or p.stat().st_size != expected['size'] or digest(p) != expected['sha256']:
            raise ValueError(f'Model file is missing or corrupt: {name}')
    return directory


def install(destination=None, *, offline=False, source=None, manifest=None, opener=urlopen):
    manifest = manifest or json.loads(MANIFEST.read_text())
    revision = manifest['revision']
    root = Path(destination or Path.home() / '.cache/conomo/models' / revision).expanduser().resolve()
    root.parent.mkdir(parents=True, exist_ok=True)
    with open(str(root) + '.install.lock', 'a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        try:
            return verify(root, manifest)
        except ValueError:
            if offline and source is None:
                raise
        with tempfile.TemporaryDirectory(prefix='.conomo-model-', dir=root.parent) as temp:
            stage = Path(temp)
            for name, expected in manifest['files'].items():
                if Path(name).name != name:
                    raise ValueError('Model manifest contains an unsafe path')
                target = stage / name
                cached = root / name
                provided = Path(source).expanduser() / name if source else cached
                # A valid caller-provided file or previous cache avoids network I/O.
                reusable = next((p for p in (provided, cached) if p.is_file() and p.stat().st_size == expected['size'] and digest(p) == expected['sha256']), None)
                if reusable:
                    shutil.copy2(reusable, target)
                elif offline:
                    raise ValueError(f'Model file unavailable offline: {name}')
                else:
                    url = f"https://huggingface.co/{manifest['repository']}/resolve/{revision}/{name}"
                    print(f'Downloading {name} ({expected["size"]:,} bytes)', flush=True)
                    with opener(url, timeout=60) as response, target.open('wb') as output:
                        shutil.copyfileobj(response, output, 1024 * 1024)
                # Check each file before the staged directory can become visible.
                if target.stat().st_size != expected['size'] or digest(target) != expected['sha256']:
                    raise ValueError(f'Model checksum mismatch: {name}')
            verify(stage, manifest)
            (stage / 'revision.json').write_text(json.dumps({'repository': manifest['repository'], 'revision': revision}) + '\n')
            # Publish a complete directory at once. Retain a corrupt old cache
            # until replacement succeeds; no partial installation is visible.
            previous = None
            if root.exists():
                previous = root.with_name(root.name + '.replacing')
                if previous.exists():
                    shutil.rmtree(previous)
                root.rename(previous)
            try:
                stage.rename(root)
            except Exception:
                if previous is not None:
                    previous.rename(root)
                raise
            if previous is not None:
                shutil.rmtree(previous)
    return root


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--destination', type=Path)
    p.add_argument('--source', type=Path, help='reuse locally installed files, after verifying hashes')
    p.add_argument('--offline', action='store_true')
    p.add_argument('--verify', type=Path)
    args = p.parse_args()
    print(verify(args.verify) if args.verify else install(args.destination, offline=args.offline, source=args.source))


if __name__ == '__main__':
    main()
