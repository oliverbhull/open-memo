#!/usr/bin/env python3
"""Safely flash one already-downloaded and signature-approved Memo UF2."""

from __future__ import annotations

import argparse
import glob
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import struct
import sys
import time

try:
    import serial
except ImportError:
    serial = None
    SerialException = OSError
else:
    SerialException = serial.SerialException

UF2_BLOCK_SIZE = 512
UF2_DATA_SIZE = 476
UF2_MAGIC_START_0 = 0x0A324655
UF2_MAGIC_START_1 = 0x9E5D5157
UF2_MAGIC_END = 0x0AB16F30
UF2_FLAG_FAMILY_ID_PRESENT = 0x00002000
NRF52840_FAMILY_ID = 0xADA52840
MEMO_CODE_PARTITION_START = 0x00027000
MEMO_CODE_PARTITION_END = 0x000EC000
EXPECTED_MODEL = "Seeed XIAO nRF52840"
EXPECTED_BOARD_ID = "Seeed_XIAO_nRF52840_Sense"
UID_PATTERN = re.compile(r"[0-9a-f]{16}")
VERSION_PATTERN = re.compile(r"[0-9]+\.[0-9]+\.[0-9]+\+[0-9a-f]{16}")
SHA256_PATTERN = re.compile(r"[0-9a-f]{64}")


class FirmwareUpdateError(RuntimeError):
    pass


def emit(state: str, **details) -> None:
    print(
        json.dumps(
            {"type": "firmware-update", "state": state, **details},
            separators=(",", ":"),
        ),
        flush=True,
    )


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    try:
        with path.open("rb") as source:
            for chunk in iter(lambda: source.read(1024 * 1024), b""):
                digest.update(chunk)
    except OSError as error:
        raise FirmwareUpdateError(f"cannot hash firmware UF2: {error}") from error
    return digest.hexdigest()


def validate_uf2(source: Path, expected_sha256: str) -> None:
    try:
        size = source.stat().st_size
    except OSError as error:
        raise FirmwareUpdateError(f"cannot inspect firmware UF2: {error}") from error
    if size == 0 or size % UF2_BLOCK_SIZE != 0:
        raise FirmwareUpdateError("firmware UF2 size is invalid")
    if size > 2 * 1024 * 1024:
        raise FirmwareUpdateError("firmware UF2 exceeds the maximum allowed size")
    if sha256(source) != expected_sha256:
        raise FirmwareUpdateError("firmware UF2 no longer matches its signed SHA-256")

    file_block_count = size // UF2_BLOCK_SIZE
    declared_block_count = None
    seen_blocks: set[int] = set()
    try:
        with source.open("rb") as input_file:
            for block_offset in range(file_block_count):
                block = input_file.read(UF2_BLOCK_SIZE)
                (
                    magic_start_0,
                    magic_start_1,
                    flags,
                    target_address,
                    payload_size,
                    block_number,
                    block_count,
                    family_id,
                ) = struct.unpack_from("<8I", block)
                (magic_end,) = struct.unpack_from("<I", block, UF2_BLOCK_SIZE - 4)
                if (
                    magic_start_0 != UF2_MAGIC_START_0
                    or magic_start_1 != UF2_MAGIC_START_1
                    or magic_end != UF2_MAGIC_END
                ):
                    raise FirmwareUpdateError(
                        f"firmware UF2 block {block_offset} has invalid magic"
                    )
                if not flags & UF2_FLAG_FAMILY_ID_PRESENT:
                    raise FirmwareUpdateError(
                        f"firmware UF2 block {block_offset} has no family ID"
                    )
                if family_id != NRF52840_FAMILY_ID:
                    raise FirmwareUpdateError(
                        f"firmware UF2 block {block_offset} targets the wrong MCU family"
                    )
                if payload_size == 0 or payload_size > UF2_DATA_SIZE:
                    raise FirmwareUpdateError(
                        f"firmware UF2 block {block_offset} has an invalid payload size"
                    )
                if (
                    target_address < MEMO_CODE_PARTITION_START
                    or target_address + payload_size > MEMO_CODE_PARTITION_END
                ):
                    raise FirmwareUpdateError(
                        f"firmware UF2 block {block_offset} targets outside Memo's code partition"
                    )
                if declared_block_count is None:
                    declared_block_count = block_count
                elif block_count != declared_block_count:
                    raise FirmwareUpdateError(
                        "firmware UF2 blocks disagree on the total block count"
                    )
                if block_number >= block_count or block_number in seen_blocks:
                    raise FirmwareUpdateError(
                        f"firmware UF2 block number {block_number} is invalid or duplicated"
                    )
                seen_blocks.add(block_number)
    except OSError as error:
        raise FirmwareUpdateError(f"cannot read firmware UF2: {error}") from error

    if declared_block_count != file_block_count or seen_blocks != set(
        range(file_block_count)
    ):
        raise FirmwareUpdateError(
            "firmware UF2 block numbers are incomplete or disagree with its size"
        )


def read_line(port) -> str:
    line = port.readline()
    if not line:
        raise TimeoutError("Memo did not respond")
    return line.decode("ascii", "strict").strip()


def command(port, text: str, timeout: float | None = None) -> str:
    previous_timeout = port.timeout
    if timeout is not None:
        port.timeout = timeout
    try:
        port.reset_input_buffer()
        port.write((text + "\n").encode("ascii"))
        port.flush()
        response = read_line(port)
        if response.startswith("ERR "):
            raise FirmwareUpdateError(f"device rejected {text!r}: {response}")
        return response
    finally:
        port.timeout = previous_timeout


def parse_hello(response: str) -> tuple[str, str]:
    fields = response.split()
    if (
        len(fields) != 6
        or fields[:2] != ["MEMO-SYNC", "2"]
        or not UID_PATTERN.fullmatch(fields[2].lower())
    ):
        raise FirmwareUpdateError(f"unexpected Memo HELLO response: {response!r}")
    return fields[2].lower(), fields[3]


def serial_candidates() -> list[Path]:
    return [
        Path(name)
        for name in sorted(
            set(glob.glob("/dev/cu.usbmodem*") + glob.glob("/dev/ttyACM*"))
        )
    ]


def open_expected_device(expected_uid: str):
    if serial is None:
        raise FirmwareUpdateError("the bundled pyserial dependency is unavailable")
    for name in serial_candidates():
        port = None
        try:
            port = serial.Serial(str(name), 115200, timeout=1, write_timeout=1)
            time.sleep(0.1)
            uid, version = parse_hello(command(port, "HELLO"))
            if uid == expected_uid:
                return port, name, version
        except (
            OSError,
            SerialException,
            TimeoutError,
            UnicodeError,
            FirmwareUpdateError,
            ValueError,
        ):
            pass
        if port is not None:
            try:
                port.close()
            except OSError:
                pass
    raise FirmwareUpdateError(f"Memo {expected_uid} is no longer connected")


def parse_uf2_info(volume: Path) -> None:
    try:
        text = (volume / "INFO_UF2.TXT").read_text(encoding="utf-8")
    except (OSError, UnicodeError) as error:
        raise FirmwareUpdateError(f"cannot read UF2 bootloader identity: {error}") from error
    fields = {}
    for line in text.splitlines():
        key, separator, value = line.partition(":")
        if separator:
            fields[key.strip()] = value.strip()
    if fields.get("Model") != EXPECTED_MODEL or fields.get("Board-ID") != EXPECTED_BOARD_ID:
        raise FirmwareUpdateError("refusing a UF2 volume for an unexpected board")


def matching_uf2_volumes(mount_root: Path) -> frozenset[Path]:
    try:
        candidates = tuple(mount_root.iterdir())
    except OSError as error:
        raise FirmwareUpdateError(f"cannot inspect UF2 mount root: {error}") from error
    matches: set[Path] = set()
    for candidate in candidates:
        try:
            if not candidate.is_dir() or not os.path.ismount(candidate):
                continue
            parse_uf2_info(candidate)
        except (FirmwareUpdateError, OSError):
            continue
        matches.add(candidate.resolve())
    return frozenset(matches)


def wait_for_new_uf2_volume(
    mount_root: Path, preexisting: frozenset[Path], timeout: float
) -> Path:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        discovered = matching_uf2_volumes(mount_root) - preexisting
        if len(discovered) > 1:
            raise FirmwareUpdateError(
                "multiple new Memo UF2 volumes appeared; refusing to choose"
            )
        if discovered:
            return next(iter(discovered))
        time.sleep(0.1)
    raise FirmwareUpdateError("Memo did not enter its UF2 bootloader")


def copy_uf2(source: Path, volume: Path) -> None:
    if not os.path.ismount(volume):
        raise FirmwareUpdateError("refusing a UF2 target that is not a mounted volume")
    parse_uf2_info(volume)
    destination = volume / "memo-firmware.uf2"
    copy_error = None
    try:
        with source.open("rb") as input_file, destination.open("wb") as output_file:
            shutil.copyfileobj(input_file, output_file, length=1024 * 1024)
            output_file.flush()
            os.fsync(output_file.fileno())
    except OSError as error:
        copy_error = error
    if copy_error is not None and volume.exists():
        raise FirmwareUpdateError(
            f"firmware copy failed while the UF2 volume remained mounted: {copy_error}"
        ) from copy_error


def wait_for_unmount(volume: Path, timeout: float) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if not volume.exists():
            return
        time.sleep(0.1)
    raise FirmwareUpdateError(
        "UF2 volume did not disappear after the firmware copy"
    )


def verify_updated_device(
    expected_uid: str, expected_version: str, timeout: float
) -> tuple[Path, str]:
    deadline = time.monotonic() + timeout
    last_error = None
    while time.monotonic() < deadline:
        try:
            port, path, _ = open_expected_device(expected_uid)
            try:
                uid, version = parse_hello(command(port, "HELLO"))
                status = command(port, "STATUS")
                if uid != expected_uid:
                    raise FirmwareUpdateError("Memo identity changed after firmware update")
                if version != expected_version:
                    raise FirmwareUpdateError(
                        f"Memo restarted with firmware {version}, expected {expected_version}"
                    )
                if status != "STATUS 0 0":
                    raise FirmwareUpdateError(
                        f"Memo was not idle and empty after firmware update: {status}"
                    )
                return path, version
            finally:
                port.close()
        except (
            OSError,
            SerialException,
            TimeoutError,
            UnicodeError,
            FirmwareUpdateError,
        ) as error:
            last_error = error
        time.sleep(0.25)
    detail = f": {last_error}" if last_error else ""
    raise FirmwareUpdateError(
        f"updated Memo {expected_uid} did not return with the expected firmware{detail}"
    )


def run_update(args) -> None:
    validate_uf2(args.uf2, args.expected_sha256)
    preexisting_volumes = matching_uf2_volumes(args.mount_root)
    port, port_path, current_version = open_expected_device(args.device_uid)
    try:
        status = command(port, "STATUS")
        if status != "STATUS 0 0":
            raise FirmwareUpdateError(
                f"refusing firmware update while Memo is not idle and empty: {status}"
            )
        emit(
            "updating-firmware",
            deviceUid=args.device_uid,
            fromVersion=current_version,
            toVersion=args.expected_version,
        )
        response = command(port, "FW REBOOT UF2", timeout=2)
        if response != "FW READY UF2":
            raise FirmwareUpdateError(f"unexpected firmware handoff response: {response}")
    finally:
        port.close()

    volume = wait_for_new_uf2_volume(
        args.mount_root, preexisting_volumes, min(args.timeout, 30)
    )
    copy_uf2(args.uf2, volume)
    wait_for_unmount(volume, min(args.timeout, 15))
    verified_port, version = verify_updated_device(
        args.device_uid, args.expected_version, args.timeout
    )
    emit(
        "firmware-updated",
        deviceUid=args.device_uid,
        firmwareVersion=version,
        port=str(verified_port),
    )


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(description=__doc__)
    result.add_argument("--uf2", type=Path, required=True)
    result.add_argument("--expected-sha256", required=True)
    result.add_argument("--expected-version", required=True)
    result.add_argument("--device-uid", required=True)
    result.add_argument("--mount-root", type=Path, default=Path("/Volumes"))
    result.add_argument("--timeout", type=float, default=60)
    return result


def main() -> int:
    args = parser().parse_args()
    args.uf2 = args.uf2.resolve()
    args.mount_root = args.mount_root.resolve()
    args.device_uid = args.device_uid.lower()
    args.expected_sha256 = args.expected_sha256.lower()
    if not UID_PATTERN.fullmatch(args.device_uid):
        raise FirmwareUpdateError("expected device UID is invalid")
    if not VERSION_PATTERN.fullmatch(args.expected_version):
        raise FirmwareUpdateError("expected firmware version is invalid")
    if not SHA256_PATTERN.fullmatch(args.expected_sha256):
        raise FirmwareUpdateError("expected firmware SHA-256 is invalid")
    if not args.mount_root.is_dir():
        raise FirmwareUpdateError("UF2 mount root does not exist")
    run_update(args)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except FirmwareUpdateError as error:
        emit("update-error", error=str(error))
        raise SystemExit(1)
    except KeyboardInterrupt:
        raise SystemExit(130)
