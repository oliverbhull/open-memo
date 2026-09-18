"""Completion handling only; no model weights or inference required."""
from types import SimpleNamespace
import unittest
from cleanup_completion import complete_output, IncompleteGeneration


class CompletionTests(unittest.TestCase):
    def test_complete_text_is_unchanged(self):
        pieces = [SimpleNamespace(text="Keep every", finish_reason=None),
                  SimpleNamespace(text=" question?", finish_reason="stop")]
        self.assertEqual(complete_output(pieces), "Keep every question?")

    def test_partial_text_is_not_delivered(self):
        for pieces in [[], [SimpleNamespace(text="Please do not", finish_reason="length")],
                       [SimpleNamespace(text="Please do not", finish_reason=None)]]:
            with self.subTest(pieces=pieces), self.assertRaises(IncompleteGeneration):
                complete_output(pieces)


if __name__ == "__main__":
    unittest.main()
