"""Subprocess-only lifecycle checks; never inspect or signal running Memo apps."""
import fcntl
import importlib.util
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch
from types import SimpleNamespace

WORKER = Path(__file__).resolve().parents[2] / 'sidecars/device-sync/device_sync.py'


@unittest.skipUnless(os.name == 'posix', 'flock and process groups require POSIX')
class DesktopLifecycleTests(unittest.TestCase):
    def test_orphan_exits_and_releases_original_lock_inode(self):
        with tempfile.TemporaryDirectory() as directory:
            lock = Path(directory) / 'sync.lock'
            ready = Path(directory) / 'ready'
            # The short-lived launcher is the worker's real parent. Keep it alive
            # until the worker has acquired its lock and started the watchdog.
            worker_code = '''
import importlib.util, fcntl, os, pathlib, sys, time
spec = importlib.util.spec_from_file_location('device_sync', sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
lock = open(sys.argv[2], 'a+')
fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
module.watch_desktop_parent(os.getppid())
pathlib.Path(sys.argv[3]).write_text(str(os.getpid()))
while True: time.sleep(1)
'''
            launcher_code = '''
import subprocess, sys
child = subprocess.Popen([sys.executable, '-c', sys.argv[1], *sys.argv[2:]], start_new_session=True)
print(child.pid, flush=True)
sys.stdin.readline()
'''
            launcher = subprocess.Popen(
                [sys.executable, '-c', launcher_code, worker_code, str(WORKER), str(lock), str(ready)],
                stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True,
            )
            worker_pid = int(launcher.stdout.readline())
            try:
                deadline = time.monotonic() + 5
                while not ready.exists() and time.monotonic() < deadline:
                    time.sleep(0.02)
                self.assertTrue(ready.exists(), 'worker never acquired the lock')
                inode = lock.stat().st_ino
                with lock.open('a+') as handle:
                    with self.assertRaises(BlockingIOError):
                        fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    launcher.stdin.close()
                    launcher.wait(timeout=5)
                    while True:
                        try:
                            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
                            break
                        except BlockingIOError:
                            if time.monotonic() >= deadline:
                                self.fail('orphan retained ownership after parent exit')
                            time.sleep(0.02)
                    self.assertEqual(lock.stat().st_ino, inode)
            finally:
                if launcher.poll() is None:
                    launcher.kill()
                    launcher.wait(timeout=5)
                launcher.stdout.close()
                try:
                    os.killpg(worker_pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass


class BatchDurabilityTests(unittest.TestCase):
    def test_manifest_failure_is_retryable_and_completed_rows_repair_manifest(self):
        spec = importlib.util.spec_from_file_location('device_sync', WORKER)
        worker = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(worker)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            database = root / 'memo.sqlite3'
            connection = worker.connect_database(database)
            batch = {'batch_id': 'test-batch', 'device_uid': 'aabb',
                     'protocol_version': 2, 'firmware_version': '1.0',
                     'started_at': worker.utc_now()}
            journal = {'recordings': []}
            try:
                worker.commit_local_batch(connection, database, batch, [])
                with patch.object(worker, 'atomic_json', side_effect=OSError('disk full')):
                    with self.assertRaises(OSError):
                        worker.complete_batch(connection, database, batch, journal, root)
                status = connection.execute('SELECT status FROM sync_batches').fetchone()[0]
                self.assertEqual(status, 'transferring')
                worker.complete_batch(connection, database, batch, journal, root)
                manifest = root / 'test-batch.json'
                original = json.loads(manifest.read_text())
                manifest.unlink()
                worker.complete_batch(connection, database, batch, journal, root)
                self.assertEqual(json.loads(manifest.read_text()), original)
                self.assertEqual(connection.execute('SELECT status FROM sync_batches').fetchone()[0], 'complete')
            finally:
                connection.close()


class FirmwareOwnershipTests(unittest.TestCase):
    def test_sync_contention_fails_before_flash_and_releases_lock_on_failure(self):
        spec = importlib.util.spec_from_file_location('firmware_update', WORKER.with_name('firmware_update.py'))
        updater = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(updater)
        with tempfile.TemporaryDirectory() as directory:
            lock = Path(directory) / 'device-sync.lock'
            args = SimpleNamespace(lock=lock)
            with lock.open('a+') as sync_owner:
                fcntl.flock(sync_owner, fcntl.LOCK_EX | fcntl.LOCK_NB)
                inode = lock.stat().st_ino
                with patch.object(updater, '_run_update_owned') as flash:
                    with self.assertRaises(updater.FirmwareUpdateError):
                        updater.run_update(args)
                    flash.assert_not_called()
                fcntl.flock(sync_owner, fcntl.LOCK_UN)

                def check_exclusive_ownership(_args):
                    with self.assertRaises(BlockingIOError):
                        fcntl.flock(sync_owner, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    raise updater.FirmwareUpdateError('simulated update failure')

                with patch.object(updater, '_run_update_owned', side_effect=check_exclusive_ownership):
                    with self.assertRaises(updater.FirmwareUpdateError):
                        updater.run_update(args)
                fcntl.flock(sync_owner, fcntl.LOCK_EX | fcntl.LOCK_NB)
                self.assertEqual(lock.stat().st_ino, inode)


if __name__ == '__main__':
    unittest.main()
