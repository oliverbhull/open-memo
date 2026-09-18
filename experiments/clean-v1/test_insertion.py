from dataclasses import replace
import unittest
from insertion import Target, admission, may_restore_clipboard

class InsertionTests(unittest.TestCase):
    def test_target(self):
        target = Target(1, 'window', 'element', (2, 3))
        self.assertEqual(admission(target, target), 'eligible')
        for change in [dict(process=2), dict(window='other'), dict(element='other'), dict(selection=(3,3))]:
            self.assertEqual(admission(target, replace(target, **change)), 'target_changed')
        self.assertEqual(admission(target, None), 'target_unknown')
    def test_field_access(self):
        target = Target(1, 'w', 'e', (0,0))
        for field, reason in [('secure','secure_field'), ('literal','literal_field')]:
            self.assertEqual(admission(target, replace(target, **{field:True})), reason)
        self.assertEqual(admission(target, replace(target, accessibility=False)), 'accessibility_denied')
    def test_clipboard(self):
        self.assertFalse(may_restore_clipboard(2,3,True))
        self.assertFalse(may_restore_clipboard(2,2,False))
        self.assertTrue(may_restore_clipboard(2,2,True))
