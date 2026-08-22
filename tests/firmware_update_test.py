from __future__ import annotations

import hashlib
import importlib.util
from pathlib import Path
import struct
import tempfile
from types import SimpleNamespace
import unittest
from unittest import mock


SOURCE = Path(__file__).parents[1] / "sidecars" / "device-sync" / "firmware_update.py"
SPEC = importlib.util.spec_from_file_location("memo_firmware_update", SOURCE)
firmware_update = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(firmware_update)


def write_uf2(path: Path, *, family_id=None, target_address=None) -> str:
    family_id = family_id or firmware_update.NRF52840_FAMILY_ID
    target_address = target_address or firmware_update.MEMO_CODE_PARTITION_START
    blocks = []
    for block_number in range(2):
        block = bytearray(firmware_update.UF2_BLOCK_SIZE)
        struct.pack_into(
            "<8I",
            block,
            0,
            firmware_update.UF2_MAGIC_START_0,
            firmware_update.UF2_MAGIC_START_1,
            firmware_update.UF2_FLAG_FAMILY_ID_PRESENT,
            target_address + block_number * 256,
            256,
            block_number,
            2,
            family_id,
        )
        block[32:288] = bytes([block_number + 1]) * 256
        struct.pack_into(
            "<I",
            block,
            firmware_update.UF2_BLOCK_SIZE - 4,
            firmware_update.UF2_MAGIC_END,
        )
        blocks.append(block)
    path.write_bytes(b"".join(blocks))
    return hashlib.sha256(path.read_bytes()).hexdigest()


class FakePort:
    def close(self) -> None:
        pass


class FirmwareUpdateTests(unittest.TestCase):
    def test_validates_signed_digest_family_and_code_partition(self):
        with tempfile.TemporaryDirectory() as temporary:
            uf2 = Path(temporary) / "memo.uf2"
            digest = write_uf2(uf2)
            firmware_update.validate_uf2(uf2, digest)

            wrong_family = Path(temporary) / "wrong-family.uf2"
            wrong_digest = write_uf2(wrong_family, family_id=0x12345678)
            with self.assertRaisesRegex(
                firmware_update.FirmwareUpdateError, "wrong MCU family"
            ):
                firmware_update.validate_uf2(wrong_family, wrong_digest)

            outside = Path(temporary) / "outside.uf2"
            outside_digest = write_uf2(
                outside,
                target_address=firmware_update.MEMO_CODE_PARTITION_END,
            )
            with self.assertRaisesRegex(
                firmware_update.FirmwareUpdateError, "outside Memo's code partition"
            ):
                firmware_update.validate_uf2(outside, outside_digest)

            with self.assertRaisesRegex(
                firmware_update.FirmwareUpdateError, "signed SHA-256"
            ):
                firmware_update.validate_uf2(uf2, "0" * 64)

    def test_update_orders_idle_check_before_handoff_copy_and_identity_verification(self):
        args = SimpleNamespace(
            uf2=Path("/tmp/memo.uf2"),
            expected_sha256="a" * 64,
            expected_version="2.0.0+0123456789abcdef",
            device_uid="0123456789abcdef",
            mount_root=Path("/Volumes"),
            timeout=60,
        )
        order = []

        def issue_command(_port, text, timeout=None):
            del timeout
            order.append(text)
            return {"STATUS": "STATUS 0 0", "FW REBOOT UF2": "FW READY UF2"}[text]

        with (
            mock.patch.object(firmware_update, "validate_uf2", side_effect=lambda *_: order.append("validate")),
            mock.patch.object(firmware_update, "matching_uf2_volumes", return_value=frozenset()),
            mock.patch.object(
                firmware_update,
                "open_expected_device",
                return_value=(FakePort(), Path("/dev/memo"), "2.0.0+oldoldoldoldoldo"),
            ),
            mock.patch.object(firmware_update, "command", side_effect=issue_command),
            mock.patch.object(
                firmware_update,
                "wait_for_new_uf2_volume",
                side_effect=lambda *_: order.append("wait-volume") or Path("/Volumes/XIAO-SENSE"),
            ),
            mock.patch.object(firmware_update, "copy_uf2", side_effect=lambda *_: order.append("copy")),
            mock.patch.object(firmware_update, "wait_for_unmount", side_effect=lambda *_: order.append("unmount")),
            mock.patch.object(
                firmware_update,
                "verify_updated_device",
                side_effect=lambda *_: order.append("verify")
                or (Path("/dev/memo"), args.expected_version),
            ),
            mock.patch.object(firmware_update, "emit"),
        ):
            firmware_update.run_update(args)

        self.assertEqual(
            order,
            [
                "validate",
                "STATUS",
                "FW REBOOT UF2",
                "wait-volume",
                "copy",
                "unmount",
                "verify",
            ],
        )

    def test_update_refuses_to_reboot_a_nonempty_or_recording_device(self):
        args = SimpleNamespace(
            uf2=Path("/tmp/memo.uf2"),
            expected_sha256="a" * 64,
            expected_version="2.0.0+0123456789abcdef",
            device_uid="0123456789abcdef",
            mount_root=Path("/Volumes"),
            timeout=60,
        )
        with (
            mock.patch.object(firmware_update, "validate_uf2"),
            mock.patch.object(firmware_update, "matching_uf2_volumes", return_value=frozenset()),
            mock.patch.object(
                firmware_update,
                "open_expected_device",
                return_value=(FakePort(), Path("/dev/memo"), "old"),
            ),
            mock.patch.object(firmware_update, "command", return_value="STATUS 1 0") as command,
        ):
            with self.assertRaisesRegex(
                firmware_update.FirmwareUpdateError, "not idle and empty"
            ):
                firmware_update.run_update(args)
        command.assert_called_once_with(mock.ANY, "STATUS")


if __name__ == "__main__":
    unittest.main()
