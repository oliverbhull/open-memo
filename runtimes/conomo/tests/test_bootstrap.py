"""Production routing must not depend on developer services or stale runtimes."""
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from conomo import bootstrap


class RuntimeSocketTest(unittest.TestCase):
    def test_external_client_keeps_shared_default(self):
        with patch.dict(os.environ, {}, clear=True):
            self.assertEqual(bootstrap.runtime_socket(), Path(bootstrap.DEFAULT_SOCKET))

    def test_explicit_route_is_preserved(self):
        with patch.dict(os.environ, {'CONOMO_SOCKET': '/tmp/custom.sock', 'CONOMO_MODEL_DIR': '/model'}, clear=True):
            self.assertEqual(bootstrap.runtime_socket(), Path('/tmp/custom.sock'))

    def test_bundle_isolated_and_update_changes_route(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            manifest = root / 'model-manifest.json'
            manifest.write_text('revision-one')
            source = root / 'bootstrap.py'
            source.write_text('runtime-one')
            with patch.dict(os.environ, {'CONOMO_MODEL_DIR': '/model'}, clear=True), patch.object(bootstrap, 'MANIFEST', manifest), patch.object(bootstrap, '__file__', str(source)):
                original = bootstrap.runtime_socket()
                self.assertNotEqual(original, Path(bootstrap.DEFAULT_SOCKET))
                self.assertIn('/Memo/asr/', str(original))
                self.assertEqual(original, bootstrap.runtime_socket())
                manifest.write_text('revision-two')
                self.assertNotEqual(original, bootstrap.runtime_socket())
                manifest.write_text('revision-one')
                source.write_text('runtime-two')
                self.assertNotEqual(original, bootstrap.runtime_socket())


if __name__ == '__main__':
    unittest.main()
