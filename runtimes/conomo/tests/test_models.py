import hashlib
import io
from pathlib import Path
import tempfile
import unittest
from conomo.models import install, verify

class ModelInstallTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)/'model'
        self.data = {'encoder.onnx': b'encoder bytes', 'tokenizer.json': b'{}'}
        self.manifest = {'repository':'example/model','revision':'a'*40,'files':{
            n:{'size':len(d),'sha256':hashlib.sha256(d).hexdigest()} for n,d in self.data.items()}}
        self.calls = []

    def tearDown(self): self.tmp.cleanup()

    def opener(self, url, **kwargs):
        self.calls.append(url)
        self.assertIn('/resolve/'+'a'*40+'/',url)
        return io.BytesIO(self.data[url.rsplit('/',1)[-1]])

    def test_install_pins_revision_and_reuses_only_verified_cache(self):
        install(self.root,manifest=self.manifest,opener=self.opener)
        self.assertEqual(len(self.calls),2)
        verify(self.root,self.manifest)
        install(self.root,offline=True,manifest=self.manifest,opener=lambda *_args,**_kwargs:self.fail('network used'))
        (self.root/'tokenizer.json').write_bytes(b'bad')
        with self.assertRaises(ValueError): install(self.root,offline=True,manifest=self.manifest)
        self.calls.clear()
        install(self.root,manifest=self.manifest,opener=self.opener)
        self.assertEqual(len(self.calls),1)
        verify(self.root,self.manifest)

    def test_checksum_failure_never_publishes_partial_model(self):
        with self.assertRaisesRegex(ValueError,'checksum'):
            install(self.root,manifest=self.manifest,opener=lambda *_args,**_kwargs:io.BytesIO(b'wrong bytes'))
        self.assertFalse(self.root.exists())
        self.assertFalse(list(self.root.parent.glob('.conomo-model-*')))

    def test_interrupted_download_can_retry_without_partial_install(self):
        def fail(*_args,**_kwargs): raise OSError('connection interrupted')
        with self.assertRaises(OSError): install(self.root,manifest=self.manifest,opener=fail)
        self.assertFalse(self.root.exists())
        install(self.root,manifest=self.manifest,opener=self.opener)
        verify(self.root,self.manifest)

    def test_local_source_must_match_same_manifest(self):
        src=self.root.parent/'source'; src.mkdir()
        for name,data in self.data.items(): (src/name).write_bytes(data)
        install(self.root,source=src,offline=True,manifest=self.manifest)
        verify(self.root,self.manifest)

if __name__=='__main__': unittest.main()
