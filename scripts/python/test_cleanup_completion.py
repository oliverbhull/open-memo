"""Completion handling only; no model weights or inference required."""
from types import SimpleNamespace
import importlib.util
import io
import json
from pathlib import Path
import unittest
from unittest.mock import patch
from cleanup_prompt import chat_messages, user_content, EMAIL_SYSTEM_PROMPT
from cleanup_completion import (complete_output, IncompleteGeneration,
                                require_preserved_wording, WordingChanged, output_token_budget)


class CompletionTests(unittest.TestCase):
    def test_email_system_prompt_is_scoped_to_email(self):
        source = "hi Sarah please do not confirm yet thanks Oliver"
        email = chat_messages(source, "email")
        self.assertNotIn("Jamie", EMAIL_SYSTEM_PROMPT)
        self.assertNotIn("Alex", EMAIL_SYSTEM_PROMPT)
        self.assertEqual(email[0], {"role": "system", "content": EMAIL_SYSTEM_PROMPT})
        self.assertEqual(email[1], {"role": "user", "content": user_content(source)})
        self.assertEqual(chat_messages(source), [email[1]])
        with self.assertRaises(ValueError):
            chat_messages(source, "arbitrary instructions")

    def test_offline_diagnostic_detects_reported_dilution(self):
        source = (
            "the system is actually working quite well but i am frustrated that when i dictate "
            "it is really changing what i say fundamentally and it is like i would say just "
            "like filtering it a little bit too much especially with longer transmission "
            "especially like especially with longer utterances like if i say a ton of words "
            "and speak for a while it just like dilutes it a lot like removes a lot of content"
        )
        rewritten = (
            "The system is actually working quite well, but I’m frustrated because when I "
            "dictate, it changes what I say fundamentally. It feels like I’m filtering it a "
            "little too much, especially with longer transmissions. If I say a ton of words "
            "and speak for a while, it dilutes the content a lot."
        )
        with self.assertRaises(WordingChanged):
            require_preserved_wording(source, rewritten)
        require_preserved_wording(source, source.capitalize() + ".")

    def test_wording_check_catches_small_but_material_changes(self):
        pairs = [
            ("it is filtering the content", "I am filtering the content"),
            ("do not send it", "Do send it."),
            ("we might start if the permit arrives", "We will start when the permit arrives."),
            ("please charge 10.5 dollars", "Please charge 105 dollars."),
            ("set it to -5", "Set it to +5."),
            ("please send it", "Please send it. Thanks, Oliver."),
            ("first check then send", "First send then check."),
            ("like the old version", "The old version."),
        ]
        for source, candidate in pairs:
            with self.subTest(source=source), self.assertRaises(WordingChanged):
                require_preserved_wording(source, candidate)
        long_source = "please keep this detail " * 150 + "do not confirm without my approval"
        with self.assertRaises(WordingChanged):
            require_preserved_wording(long_source, "please keep this detail " * 150)

    def test_wording_check_allows_layout_contractions_and_minimal_fillers(self):
        require_preserved_wording(
            "um hi Jason uh we will make it work thanks Oliver",
            "Hi Jason,\n\nWe’ll make it work.\n\nThanks,\nOliver",
        )
        require_preserved_wording("i cannot send __MEMO_VOCAB_0_0__", "I can’t send __MEMO_VOCAB_0_0__.")
        require_preserved_wording("uh um", "uh um")

    def test_long_dictation_has_a_source_sized_output_budget(self):
        self.assertGreater(output_token_budget(1000), 1000)
        self.assertEqual(output_token_budget(10000), 8192)
        self.assertGreaterEqual(output_token_budget(1), 64)

    def test_complete_text_is_unchanged(self):
        pieces = [SimpleNamespace(text="Keep every", finish_reason=None),
                  SimpleNamespace(text=" question?", finish_reason="stop")]
        self.assertEqual(complete_output(pieces), "Keep every question?")

    def test_partial_text_is_not_delivered(self):
        for pieces in [[], [SimpleNamespace(text="Please do not", finish_reason="length")],
                       [SimpleNamespace(text="Please do not", finish_reason=None)]]:
            with self.subTest(pieces=pieces), self.assertRaises(IncompleteGeneration):
                complete_output(pieces)

    def test_worker_rejection_keeps_request_id_and_accepts_next_request(self):
        spec = importlib.util.spec_from_file_location(
            "cleanup_worker", Path(__file__).with_name("transcript-cleanup-worker.py"))
        worker = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(worker)
        messages_seen = []

        def apply_template(messages, **kwargs):
            messages_seen.append(messages)
            return "prompt"

        tokenizer = SimpleNamespace(
            bos_token=None,
            apply_chat_template=apply_template,
            encode=lambda prompt, **kwargs: [1],
        )
        modules = {
            "mlx": SimpleNamespace(core=SimpleNamespace()),
            "mlx.core": SimpleNamespace(),
            "mlx_lm": SimpleNamespace(
                load=lambda *args, **kwargs: (None, tokenizer),
                generate=lambda *args, **kwargs: None,
                stream_generate=lambda *args, **kwargs: iter([
                    SimpleNamespace(text=("I am filtering." if messages_seen[-1][-1]["content"].endswith("it is filtering")
                          else messages_seen[-1][-1]["content"].split("Transcript: ", 1)[1].capitalize() + "."), finish_reason="stop")]),
            ),
            "mlx_lm.models.cache": SimpleNamespace(make_prompt_cache=lambda model: None),
            "mlx_lm.sample_utils": SimpleNamespace(make_sampler=lambda **kwargs: None),
        }
        requests = [
            {"id": "oversized", "text": "x" * 20001},
            {"id": "email", "text": "hello Sarah", "format": "email"},
            {"id": "bad-format", "text": "hello", "format": "arbitrary"},
            {"id": "rewrite", "text": "it is filtering"},
            {"id": "valid", "text": "hello there"},
        ]
        output = io.StringIO()
        with patch.dict("sys.modules", modules), \
                patch("sys.stdin", io.StringIO("\n".join(map(json.dumps, requests)))), \
                patch("sys.stdout", output):
            worker.run_worker(Path("unused-model"), None, None, False)
        ready, rejected, email, bad_format, rewrite, accepted = map(json.loads, output.getvalue().splitlines())
        self.assertEqual(ready["type"], "ready")
        self.assertEqual(rejected["id"], "oversized")
        self.assertEqual(rejected["status"], "fallback")
        self.assertEqual(email["status"], "accepted")
        self.assertEqual(bad_format["id"], "bad-format")
        self.assertEqual(bad_format["status"], "fallback")
        self.assertEqual(messages_seen[1][0]["role"], "system")
        self.assertEqual(messages_seen[3], chat_messages("hello there"))
        self.assertNotIn("reason", rewrite)
        self.assertEqual(rewrite["status"], "accepted")
        self.assertEqual(rewrite["text"], "I am filtering.")
        self.assertEqual(rewrite["candidate_text"], "I am filtering.")
        self.assertEqual(accepted["id"], "valid")
        self.assertEqual(accepted["status"], "accepted")


if __name__ == "__main__":
    unittest.main()
