from __future__ import annotations

import importlib.util
import io
from pathlib import Path
import struct
from unittest import mock
import tempfile
from types import SimpleNamespace
import unittest
import json
import zlib


SOURCE = Path(__file__).parents[1] / "sidecars" / "device-sync" / "device_sync.py"
SPEC = importlib.util.spec_from_file_location("memo_device_sync", SOURCE)
device_sync = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(device_sync)


class FakePort:
    def __init__(self, lines: list[bytes], payload: bytes):
        self.lines = list(lines)
        self.payload = io.BytesIO(payload)
        self.timeout = 1.0
        self.writes: list[bytes] = []
        self.closed = False

    def write(self, data: bytes) -> None:
        self.writes.append(data)

    def flush(self) -> None:
        pass

    def readline(self) -> bytes:
        return self.lines.pop(0) if self.lines else b""

    def read(self, size: int) -> bytes:
        return self.payload.read(size)

    def close(self) -> None:
        self.closed = True


class DeviceSyncTests(unittest.TestCase):
    def test_transport_prefers_usb_and_does_not_start_ble(self):
        usb = object()
        with mock.patch.object(device_sync, "open_usb_sync_port", return_value=(usb, {"device_uid": "one"}, "/dev/memo")), \
             mock.patch.object(device_sync, "open_ble_sync_port") as open_ble:
            self.assertEqual(
                device_sync.open_sync_transport(Path("/bridge")),
                (usb, {"device_uid": "one"}, "/dev/memo", "usb"),
            )
            open_ble.assert_not_called()

    def test_transport_falls_back_to_ble(self):
        ble = object()
        with mock.patch.object(device_sync, "open_usb_sync_port", return_value=(None, None, None)), \
             mock.patch.object(device_sync, "open_ble_sync_port", return_value=(ble, {"device_uid": "two"}, "Bluetooth")):
            self.assertEqual(
                device_sync.open_sync_transport(Path("/bridge")),
                (ble, {"device_uid": "two"}, "Bluetooth", "ble"),
            )

    def test_usb_connection_establishes_and_replaces_ble_trust(self):
        with tempfile.TemporaryDirectory() as temporary:
            trusted = Path(temporary) / "trusted.json"
            device_sync.remember_usb_device(trusted, {"protocol_version": 2, "device_uid": "aabb"})
            self.assertEqual(device_sync.trusted_device_uid(trusted), "aabb")
            device_sync.remember_usb_device(trusted, {"protocol_version": 2, "device_uid": "ccdd"})
            self.assertEqual(device_sync.trusted_device_uid(trusted), "ccdd")

    def test_invalid_trusted_identity_fails_closed(self):
        with tempfile.TemporaryDirectory() as temporary:
            trusted = Path(temporary) / "trusted.json"
            trusted.write_text('{"device_uid":"not a uid"}')
            with self.assertRaisesRegex(RuntimeError, "trusted Memo identity is invalid"):
                device_sync.trusted_device_uid(trusted)

    def test_ble_rejects_a_different_device_uid(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            bridge = root / "bridge"
            bridge.write_text("stub")
            bridge.chmod(0o755)
            trusted = root / "trusted.json"
            device_sync.atomic_json(trusted, {"device_uid": "aabb"})
            port = FakePort([b"MEMO-SYNC 2 ccdd 2.0.1 00000000 0\n"], b"")
            with mock.patch.object(device_sync, "BlePort", return_value=port):
                opened, info, endpoint = device_sync.open_ble_sync_port(bridge, trusted)
            self.assertEqual((opened, info, endpoint), (None, None, None))
            self.assertTrue(port.closed)

    def test_ble_does_not_scan_before_usb_trust_is_established(self):
        with tempfile.TemporaryDirectory() as temporary:
            bridge = Path(temporary) / "bridge"
            bridge.write_text("stub")
            bridge.chmod(0o755)
            with mock.patch.object(device_sync, "BlePort") as ble_port:
                self.assertEqual(
                    device_sync.open_ble_sync_port(bridge, Path(temporary) / "missing.json"),
                    (None, None, None),
                )
            ble_port.assert_not_called()

    def test_batch_transcription_requires_desktop_grant(self):
        with mock.patch.object(device_sync.sys, "stdin", io.StringIO("CONTINUE\n")):
            device_sync.await_transcription_slot()
        with mock.patch.object(device_sync.sys, "stdin", io.StringIO("\n")):
            with self.assertRaisesRegex(RuntimeError, "did not grant"):
                device_sync.await_transcription_slot()

    def test_hello_rejects_logging_port_and_parses_v2(self):
        info = device_sync.parse_hello("MEMO-SYNC 2 abcdef0123456789 1.2.3 0000000a 42", "/dev/test")
        self.assertEqual(info["device_uid"], "abcdef0123456789")
        with self.assertRaises(RuntimeError):
            device_sync.parse_hello("old log output", "/dev/log")

    def test_sync_signal_accepts_each_firmware_response(self):
        info = {"protocol_version": 2}
        for state, response in (("BEGIN", "SYNC BEGIN batch"), ("COMMIT", "SYNC OK batch"), ("ERROR", "SYNC ERROR batch")):
            port = FakePort([f"{response}\n".encode()], b"")
            device_sync.signal_sync(port, info, state, "batch")

    def test_commit_accepts_newer_pending_recordings(self):
        port = FakePort([b"ERR -16\n", b"STATUS 6 0\n"], b"")
        self.assertEqual(device_sync.commit_sync(port, {"protocol_version": 2}, "batch"), 6)
        self.assertEqual(port.writes, [b"SYNC COMMIT batch\n", b"STATUS\n"])

    def test_commit_does_not_hide_active_capture(self):
        port = FakePort([b"ERR -16\n", b"STATUS 6 1\n"], b"")
        with self.assertRaisesRegex(RuntimeError, "ERR -16"):
            device_sync.commit_sync(port, {"protocol_version": 2}, "batch")

    def test_mrec_v1_and_v2_metadata(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            v1 = root / "v1.mrec"
            v1.write_bytes(struct.pack("<IHHI", device_sync.MREC_MAGIC, 1, 0, 42))
            self.assertEqual(device_sync.parse_mrec(v1)["device_recording_id"], 42)

            v2 = root / "v2.mrec"
            values = (device_sync.MREC_MAGIC, 2, device_sync.MREC_V2.size, 43, 0x1234, 43,
                      1, 2, 3, 0, 0x5355504F, 16000, 1, 20, 7, 1000, 0, -420, 0, 0, 100)
            v2.write_bytes(device_sync.MREC_V2.pack(*values))
            metadata = device_sync.parse_mrec(v2)
            self.assertEqual(metadata["device_recording_id"], 43)
            self.assertEqual(metadata["codec"], "opus")

    def test_pull_verifies_crc_before_atomic_publish(self):
        payload = b"memo recording payload"
        crc = zlib.crc32(payload) & 0xFFFFFFFF
        port = FakePort(
            [f"DATA 0000002a {len(payload)} {crc:08x}\n".encode(), b"DONE 0000002a\n"],
            payload + b"\n",
        )
        with tempfile.TemporaryDirectory() as temporary:
            destination = Path(temporary) / "source.mrec"
            size, actual_crc = device_sync.pull_one(port, 42, len(payload), destination)
            self.assertEqual((size, actual_crc), (len(payload), crc))
            self.assertEqual(destination.read_bytes(), payload)
            self.assertFalse(destination.with_suffix(".part").exists())

    def test_schema_is_durable_and_router_compatible(self):
        with tempfile.TemporaryDirectory() as temporary:
            database = Path(temporary) / "memo.sqlite3"
            connection = device_sync.connect_database(database)
            columns = {row[1] for row in connection.execute("PRAGMA table_info(sync_batches)")}
            self.assertTrue({"router_state", "router_attempt_count", "router_next_attempt_at"} <= columns)
            connection.close()
            self.assertTrue(database.exists())

    def test_blank_and_diagnostic_transcripts_are_not_meaningful(self):
        self.assertFalse(device_sync.meaningful(""))
        self.assertFalse(device_sync.meaningful("[blank_audio]"))
        self.assertFalse(device_sync.meaningful("(music)"))
        self.assertTrue(device_sync.meaningful("Remember to inspect level three"))

    def test_empty_device_artifact_gets_valid_empty_wav(self):
        with tempfile.TemporaryDirectory() as temporary:
            wav = Path(temporary) / "empty.wav"
            device_sync.write_empty_wav(wav)
            self.assertEqual(wav.read_bytes()[0:4], b"RIFF")
            self.assertEqual(len(wav.read_bytes()), 44)

    def test_audio_too_short_is_a_per_recording_diagnostic(self):
        requests = [
            {"id": "short", "input": "/tmp/short.mrec", "wav": "/tmp/short.wav"},
            {"id": "valid", "input": "/tmp/valid.mrec", "wav": "/tmp/valid.wav"},
        ]
        output = "\n".join(
            (
                '{"type":"error","id":"short","error":"Error: Audio too short"}',
                '{"type":"result","id":"valid","text":"hello","opusFrames":50,"durationSeconds":1.0}',
            )
        )
        completed = SimpleNamespace(stdout=output, stderr="", returncode=0)
        with mock.patch.object(device_sync.subprocess, "run", return_value=completed):
            rows = device_sync.transcribe_batch(Path("/tmp/memo-stt"), requests, {})

        self.assertEqual(rows["short"]["text"], "")
        self.assertEqual(rows["short"]["opusFrames"], 0)
        self.assertEqual(rows["valid"]["text"], "hello")

    def test_non_diagnostic_transcription_error_still_fails_batch(self):
        output = '{"type":"error","id":"broken","error":"model crashed"}'
        completed = SimpleNamespace(stdout=output, stderr="", returncode=0)
        with mock.patch.object(device_sync.subprocess, "run", return_value=completed):
            with self.assertRaisesRegex(RuntimeError, "model crashed"):
                device_sync.transcribe_batch(
                    Path("/tmp/memo-stt"),
                    [{"id": "broken", "input": "/tmp/a", "wav": "/tmp/b"}],
                    {},
                )

    def test_ack_verification_ignores_newer_recordings(self):
        port = FakePort(
            [b"FILE 00000012 78\n", b"FILE 00000013 23404\n", b"END 2\n"],
            b"",
        )
        journal = {"recordings": [{"id": "00000002"}, {"id": "00000003"}]}
        self.assertEqual(device_sync.unacknowledged_batch_ids(port, journal), [])

    def test_ack_verification_reports_only_current_batch_ids(self):
        port = FakePort(
            [b"FILE 00000003 36988\n", b"FILE 00000012 78\n", b"END 2\n"],
            b"",
        )
        journal = {"recordings": [{"id": "00000002"}, {"id": "00000003"}]}
        self.assertEqual(device_sync.unacknowledged_batch_ids(port, journal), ["00000003"])

    def test_interrupted_item_accepts_crc_verified_staged_copy(self):
        with tempfile.TemporaryDirectory() as temporary:
            stage = Path(temporary)
            payload = b"already copied before device removal"
            (stage / "source.mrec").write_bytes(payload)
            item = {
                "stage": str(stage),
                "crc32": f"{zlib.crc32(payload) & 0xFFFFFFFF:08x}",
            }
            self.assertTrue(device_sync.journal_item_has_durable_copy(item))
            item["crc32"] = "00000000"
            self.assertFalse(device_sync.journal_item_has_durable_copy(item))

    def test_archive_validation_checks_files_not_only_manifest(self):
        with tempfile.TemporaryDirectory() as temporary:
            archive = Path(temporary)
            source = archive / "source.mrec"
            audio = archive / "audio.wav"
            source.write_bytes(b"recording")
            audio.write_bytes(b"audio")
            crc32 = f"{zlib.crc32(source.read_bytes()) & 0xFFFFFFFF:08x}"
            (archive / "manifest.json").write_text(json.dumps({
                "status": "complete",
                "source_crc32": crc32,
                "source_sha256": device_sync.sha256(source),
                "audio_sha256": device_sync.sha256(audio),
            }), encoding="utf-8")
            item = {"archive_path": str(archive), "crc32": crc32}
            self.assertEqual(device_sync.validate_archive(item)["status"], "complete")
            source.write_bytes(b"corrupt")
            with self.assertRaisesRegex(RuntimeError, "archive is invalid"):
                device_sync.validate_archive(item)

    def test_invalid_journal_cannot_be_overwritten(self):
        with tempfile.TemporaryDirectory() as temporary:
            journal = Path(temporary) / "journal.json"
            args = SimpleNamespace(journal=journal)
            for contents in ("not json", '{"phase":"mystery"}'):
                journal.write_text(contents, encoding="utf-8")
                with self.assertRaisesRegex(RuntimeError, "refusing to overwrite"):
                    device_sync.process_device(
                        FakePort([], b""),
                        {"device_uid": "device"},
                        "/dev/test",
                        args,
                        None,
                    )
                self.assertEqual(journal.read_text(encoding="utf-8"), contents)

    def test_durable_recording_is_emitted_before_optional_commit(self):
        journal = {
            "batch_id": "batch",
            "device_uid": "device",
            "protocol_version": 2,
            "firmware_version": "1.0",
            "started_at": "now",
            "recordings": [],
        }
        args = SimpleNamespace(database=Path("/tmp/db"), batch_directory=Path("/tmp"), journal=Path("/tmp/journal"), requested_model="granite", actual_model="granite")
        connection = mock.Mock()
        connection.execute.return_value.fetchall.return_value = [{"source_sha256": "a" * 64}]
        order = []
        with (
            mock.patch.object(device_sync, "commit_local_batch"),
            mock.patch.object(device_sync, "list_recordings", return_value=[]),
            mock.patch.object(device_sync, "complete_batch"),
            mock.patch.object(device_sync, "emit_recording", side_effect=lambda _row: order.append("emit")),
            mock.patch.object(device_sync, "commit_sync", side_effect=lambda *_args: order.append("commit") or (_ for _ in ()).throw(RuntimeError("disconnect"))),
        ):
            with self.assertRaisesRegex(RuntimeError, "disconnect"):
                device_sync.resume_ack(FakePort([], b""), {"device_uid": "device"}, args, connection, journal)
        self.assertEqual(order, ["emit", "commit"])

    def test_different_device_cannot_overwrite_interrupted_journal(self):
        with tempfile.TemporaryDirectory() as temporary:
            journal = Path(temporary) / "journal.json"
            journal.write_text(
                '{"phase":"pulling","device_uid":"first-device","recordings":[]}',
                encoding="utf-8",
            )
            args = SimpleNamespace(journal=journal)
            with self.assertRaisesRegex(RuntimeError, "different Memo"):
                device_sync.process_device(
                    FakePort([], b""),
                    {"device_uid": "second-device"},
                    "/dev/test",
                    args,
                    None,
                )
            self.assertEqual(
                journal.read_text(encoding="utf-8"),
                '{"phase":"pulling","device_uid":"first-device","recordings":[]}',
            )


if __name__ == "__main__":
    unittest.main()
