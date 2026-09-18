import copy
import unittest
from dataset import digest, export_rows

class DatasetTests(unittest.TestCase):
    def rows(self):
        return [dict(id=str(i), contract='memo-clean-v1', review_status='human_approved', reviewer='synthetic-test-only',
                     reviewed_target_sha256=digest(text), source_sha256=digest(text), source=text, target=text,
                     source_kind='synthetic', license_or_consent='test fixture', exposure='development',
                     split=split, speaker=str(i), recording=str(i), family=str(i), template=str(i), decision='noop')
                for i, (text,split) in enumerate([('Pay 10.', 'train'),('Send 20.', 'validation')])]
    def test_good(self): self.assertEqual(len(export_rows(self.rows())['train']), 1)
    def test_literal_identity(self):
        rows=self.rows(); rows[0]['target']='Pay 11.'; rows[0]['reviewed_target_sha256']=digest('Pay 11.')
        with self.assertRaisesRegex(ValueError, 'literal_value_changed'): export_rows(rows)
    def test_unmatched_unit_symbol(self):
        rows=self.rows(); rows[0]['source']='temperature 12 °C'; rows[0]['source_sha256']=digest(rows[0]['source'])
        rows[0]['target']='temperature 12 C'; rows[0]['reviewed_target_sha256']=digest(rows[0]['target'])
        with self.assertRaisesRegex(ValueError,'literal_symbol_changed'): export_rows(rows)

    def test_review(self):
        rows=self.rows(); rows[0]['review_status']='machine_proposed'
        with self.assertRaisesRegex(ValueError,'unapproved'): export_rows(rows)
    def test_leakage(self):
        rows=self.rows(); rows[1]['family']=rows[0]['family']
        with self.assertRaisesRegex(ValueError,'group_leakage'): export_rows(rows)
    def test_locked(self):
        rows=self.rows(); rows[0]['exposure']='unseen'
        with self.assertRaisesRegex(ValueError,'evaluation_isolation'): export_rows(rows)
