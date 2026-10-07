import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest import mock
from io import BytesIO

spec = importlib.util.spec_from_file_location('cleanup_loop', Path(__file__).with_name('loop.py'))
loop = importlib.util.module_from_spec(spec)
spec.loader.exec_module(loop)


class DatasetTests(unittest.TestCase):
    def test_native_model_fetch_excludes_duplicate_runtime_exports(self):
        metadata = {'sha': 'fixed', 'siblings': [{'rfilename': f} for f in [
            'config.json', 'model.safetensors', 'tokenizer.json', 'LICENSE', 'README.md',
            'onnx/model.onnx', 'model-q4.gguf', 'training_args.bin',
        ]]}
        with tempfile.TemporaryDirectory() as directory:
            with mock.patch.object(loop, 'WORK', Path(directory)), \
                 mock.patch.object(loop.shutil, 'which', return_value='/bin/hf'), \
                 mock.patch.object(loop.urllib.request, 'urlopen', return_value=BytesIO(json.dumps(metadata).encode())), \
                 mock.patch.object(loop, 'run_command') as download:
                loop.fetch_one({'repo': 'official/model', 'revision': 'fixed'}, 'models')
            command = download.call_args.args[0]
            self.assertIn('model.safetensors', command)
            self.assertIn('LICENSE', command)
            self.assertNotIn('onnx/model.onnx', command)
            self.assertNotIn('model-q4.gguf', command)
            self.assertNotIn('training_args.bin', command)

    def test_training_uses_clean_target_not_broad_rewrite_pair(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'source.jsonl'
            loop.write_rows(path, [
                {'_id': '1', 'task': 'simplification', 'tgt': 'Do not use this rewrite as a formatting target.'},
                {'_id': '2', 'task': 'gec', 'src': 'Fix grammar: I will change the subject.',
                 'tgt': 'I am not certain that we should place the order today.'},
            ])
            pair = loop.public_pairs(path, 'train', 1, set())[0]
            self.assertEqual(pair['input'], 'i am not certain that we should place the order today')
            self.assertEqual(pair['expected_output'], 'I am not certain that we should place the order today.')
            self.assertEqual(pair['source_row_id'], '2')

    def test_decimal_and_contraction_preserved(self):
        source = "We don't need $12.50 today. Please wait until tomorrow!"
        raw = loop.raw_from_clean(source)
        self.assertIn('$12.50', raw)
        self.assertIn("don't", raw)
        self.assertEqual(loop.content_tokens(raw), loop.content_tokens(source))

    def test_normalized_split_collision_rejected(self):
        with self.assertRaisesRegex(ValueError, 'duplicate'):
            loop.validate_disjoint({'train': [{'input': 'Do not ship today.'}],
                                    'valid': [{'input': 'do not ship today'}]})

    def test_reserved_evaluation_not_sent_to_inference(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'cases.jsonl'
            loop.write_rows(path, [{'id': 'dev', 'split': 'development', 'input': 'dev'},
                                   {'id': 'reserved', 'split': 'reserved_evaluation', 'input': 'reserved'}])
            self.assertEqual([r['id'] for r in loop.snapshot_evaluation(path, 50)], ['dev'])

    def test_locked_asset_mutation_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root/'weights').write_bytes(b'original')
            lock = loop.model_inventory(root)
            (root/'weights').write_bytes(b'modified')
            with self.assertRaisesRegex(ValueError, 'changed'):
                loop.verify_inventory(root, lock)

    def test_missing_detail_and_number_change_flagged(self):
        result = loop.diagnostics('meet tomorrow at 1 pm', 'Meet at 12 pm.')
        self.assertIn('tomorrow', result['missing_tokens'])
        self.assertFalse(result['number_tokens_preserved'])

    def test_incomplete_generation_not_disguised_as_pass(self):
        result = loop.diagnostics('please do not ship', '')
        self.assertFalse(result['nonempty'])
        self.assertTrue(result['polarity_tokens_changed'])

    def test_related_curated_examples_cannot_cross_splits(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            loop.write_rows(root/'evaluation.jsonl', [])
            loop.write_rows(root/'pairs.jsonl', [
                {'id': 'a', 'family_id': 'same', 'split': 'train', 'input': 'meet tomorrow',
                 'expected_output': 'Meet tomorrow.', 'review_status': 'draft'},
                {'id': 'b', 'family_id': 'same', 'split': 'valid', 'input': 'meet today',
                 'expected_output': 'Meet today.', 'review_status': 'draft'},
            ])
            with self.assertRaisesRegex(ValueError, 'cross train/valid'):
                loop.prepare(root, {}, root/'evaluation.jsonl', root/'pairs.jsonl')

    def test_two_equally_partial_outputs_cannot_complete_a_run(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            loop.write_json(root/'run.json', {'dataset_path': str(root)})
            loop.write_rows(root/'evaluation.jsonl', [{'id': 'one'}, {'id': 'two'}])
            loop.write_rows(root/'valid.pairs.jsonl', [])
            for variant in ['base', 'adapter']:
                loop.write_rows(root/f'{variant}.jsonl', [{'id': 'one'}])
            with self.assertRaisesRegex(ValueError, 'Incomplete'):
                loop.summarize(root)

    def test_base_screen_comparison_does_not_require_an_adapter(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            loop.write_json(root/'run.json', {
                'run_type': 'base_model_screen', 'dataset_path': str(root),
                'config': {'model': 'lfm-350m', 'iterations': 20},
                'dataset_manifest': {'version': 'fixed'}, 'model_lock': {'total_bytes': 100},
                'evaluation_sha256': 'same-evaluation',
            })
            loop.write_rows(root/'evaluation.jsonl', [{'id': 'one'}])
            loop.write_rows(root/'valid.pairs.jsonl', [])
            loop.write_rows(root/'base.jsonl', [{
                'id': 'one', 'split': 'development', 'input': 'hello', 'output': 'Hello.',
                'finish_reason': 'stop', 'latency_ms': 100, 'cold_first_request': True,
                'diagnostics': loop.diagnostics('hello', 'Hello.'),
            }])
            loop.write_json(root/'base.runtime.json', {})
            summary = loop.summarize(root)
            self.assertEqual(set(summary['variants']), {'base'})
            compared = loop.compare_runs([root])['runs'][0]
            self.assertEqual(compared['adapter_bytes'], 0)
            self.assertEqual(compared['reviewed_cases'], 0)
            self.assertIsNone(compared['reviewer_flagged_critical_errors'])


if __name__ == '__main__':
    unittest.main()
