#!/usr/bin/env python3
"""App-owned, crash-safe Memo USB ingestion worker.

Stdout is JSONL for Electron. Stderr is diagnostic logging only.
"""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
import fcntl
import glob
import hashlib
import json
import os
from pathlib import Path
import re
import select
import shutil
import sqlite3
import struct
import subprocess
import sys
import time
import uuid
import wave
import zlib

try:
    import serial
except ImportError:  # Unit tests can exercise the protocol without the packaged runtime.
    serial = None
    SerialException = OSError
else:
    SerialException = serial.SerialException

MREC_MAGIC = 0x4345524D
MREC_V1 = struct.Struct("<IHHI")
MREC_V2 = struct.Struct("<IHHIQQHHHHIIHHIQqhBBI")
CAPTURE_TIME_VALID = 0x01
CLOCK_SOURCES = {0: "unknown", 1: "usb", 2: "ble"}
CODECS = {0x5355504F: "opus"}


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def emit(state: str, **details) -> None:
    print(json.dumps({"type": "status", "state": state, **details}, separators=(",", ":")), flush=True)


def emit_recording(row: dict) -> None:
    print(json.dumps({"type": "recording", "recording": row}, separators=(",", ":")), flush=True)


def await_transcription_slot() -> None:
    if sys.stdin.readline().strip() != "CONTINUE":
        raise RuntimeError("desktop did not grant the batch transcription slot")


def atomic_json(path: Path, value: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    with temporary.open("w", encoding="utf-8") as output:
        json.dump(value, output, ensure_ascii=False, indent=2, sort_keys=True)
        output.write("\n")
        output.flush()
        os.fsync(output.fileno())
    os.replace(temporary, path)
    fsync_path(path.parent)


def fsync_path(path: Path) -> None:
    descriptor = os.open(path, os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def trusted_device_uid(path: Path) -> str | None:
    if not path.exists():
        return None
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        raise RuntimeError("refusing BLE sync because the trusted Memo identity is unreadable") from error
    uid = value.get("device_uid") if isinstance(value, dict) else None
    if not isinstance(uid, str) or not re.fullmatch(r"[0-9a-f]+", uid):
        raise RuntimeError("refusing BLE sync because the trusted Memo identity is invalid")
    return uid


def remember_usb_device(path: Path, info: dict) -> None:
    uid = info.get("device_uid")
    if info.get("protocol_version", 0) < 2 or not isinstance(uid, str):
        return
    existing = trusted_device_uid(path)
    if existing != uid:
        atomic_json(path, {"device_uid": uid, "trusted_via": "usb", "created_at": utc_now()})


def parse_hello(response: str, port_name: str) -> dict:
    fields = response.split()
    if fields == ["MEMO-SYNC", "1"]:
        return {"protocol_version": 1, "device_uid": "legacy-unknown-device", "firmware_version": None}
    if len(fields) == 6 and fields[:2] == ["MEMO-SYNC", "2"]:
        int(fields[4], 16)
        int(fields[5])
        return {"protocol_version": 2, "device_uid": fields[2].lower(), "firmware_version": fields[3]}
    raise RuntimeError(f"unexpected HELLO response on {port_name}: {response}")


def read_line(port) -> str:
    line = port.readline()
    if not line:
        raise TimeoutError("Memo did not respond")
    return line.decode("ascii", "strict").strip()


class BlePort:
    """Serial-like byte stream backed by the narrow CoreBluetooth helper."""

    def __init__(self, bridge: Path, excluded: set[str] | None = None):
        self.timeout = 1.0
        command = [str(bridge)]
        for identifier in sorted(excluded or set()):
            command.extend(["--exclude", identifier])
        self.process = subprocess.Popen(
            command, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            bufsize=0,
        )
        if self.process.stdin is None or self.process.stdout is None:
            self.close()
            raise RuntimeError("BLE bridge did not expose a byte stream")
        self.input = self.process.stdin
        self.output = self.process.stdout
        self.buffer = bytearray()

    def write(self, data: bytes) -> None:
        if self.process.poll() is not None:
            raise OSError(self._failure())
        self.input.write(data)

    def flush(self) -> None:
        self.input.flush()

    def read(self, size: int) -> bytes:
        deadline = time.monotonic() + float(self.timeout or 0)
        while len(self.buffer) < size:
            remaining = deadline - time.monotonic()
            if remaining <= 0 or not select.select([self.output], [], [], remaining)[0]:
                break
            chunk = os.read(self.output.fileno(), max(4096, size - len(self.buffer)))
            if not chunk:
                break
            self.buffer.extend(chunk)
        result = bytes(self.buffer[:size])
        del self.buffer[:size]
        return result

    def readline(self) -> bytes:
        deadline = time.monotonic() + float(self.timeout or 0)
        while b"\n" not in self.buffer:
            remaining = deadline - time.monotonic()
            if remaining <= 0 or not select.select([self.output], [], [], remaining)[0]:
                return b""
            chunk = os.read(self.output.fileno(), 4096)
            if not chunk:
                return b""
            self.buffer.extend(chunk)
        boundary = self.buffer.index(b"\n") + 1
        result = bytes(self.buffer[:boundary])
        del self.buffer[:boundary]
        return result

    def close(self) -> None:
        if self.process.poll() is None:
            self.process.terminate()
            try:
                self.process.wait(timeout=1)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait()

    def _failure(self) -> str:
        if self.process.stderr is None:
            return "BLE bridge closed"
        diagnostics = self.process.stderr.read().decode("utf-8", "replace").strip()
        return diagnostics or "BLE bridge closed"


def open_usb_sync_port():
    if serial is None:
        raise RuntimeError("the bundled pyserial dependency is unavailable")
    candidates = sorted(set(glob.glob("/dev/cu.usbmodem*") + glob.glob("/dev/ttyACM*")))
    for name in candidates:
        for attempt in range(3):
            port = None
            try:
                port = serial.Serial(name, 115200, timeout=1, write_timeout=1)
                time.sleep(0.1)
                port.reset_input_buffer()
                port.write(b"HELLO\n")
                port.flush()
                info = parse_hello(read_line(port), name)
                return port, info, name
            except (OSError, SerialException, TimeoutError, UnicodeError, RuntimeError, ValueError):
                if port is not None:
                    try:
                        port.close()
                    except OSError:
                        pass
                if attempt < 2:
                    time.sleep(0.25)
    return None, None, None


def open_ble_sync_port(bridge: Path | None, trusted_device: Path | None = None):
    if bridge is None or not bridge.is_file() or not os.access(bridge, os.X_OK):
        return None, None, None
    if trusted_device is None:
        return None, None, None
    trusted_uid = trusted_device_uid(trusted_device)
    if trusted_uid is None:
        return None, None, None
    excluded: set[str] = set()
    for _ in range(8):
        port = BlePort(bridge, excluded)
        try:
            # Discovery, connection and encrypted notification subscription may prompt
            # on first use, so the initial handshake gets a bounded longer deadline.
            port.timeout = 10.0
            port.write(b"HELLO\n")
            port.flush()
            bridge_line = read_line(port).split()
            if len(bridge_line) != 2 or bridge_line[0] != "BRIDGE":
                raise RuntimeError("BLE bridge did not identify the connected peripheral")
            peripheral_id = bridge_line[1]
            info = parse_hello(read_line(port), "Bluetooth")
            if info["device_uid"] == trusted_uid:
                port.timeout = 1.0
                return port, info, "Bluetooth"
            excluded.add(peripheral_id)
            port.close()
        except (OSError, TimeoutError, UnicodeError, RuntimeError, ValueError) as error:
            port.close()
            if port.process.returncode == 3:
                return None, None, None
            details = port._failure() if port.process.returncode not in (0, -15) else str(error)
            raise RuntimeError(f"BLE sync unavailable: {details}") from error
    raise RuntimeError("BLE sync unavailable: too many untrusted Memo recorders are advertising")


def open_sync_transport(ble_bridge: Path | None = None, trusted_device: Path | None = None):
    port, info, endpoint = open_usb_sync_port()
    if port is not None:
        return port, info, endpoint, "usb"
    port, info, endpoint = open_ble_sync_port(ble_bridge, trusted_device)
    if port is not None:
        return port, info, endpoint, "ble"
    return None, None, None, None


def command(port, text: str, timeout: float | None = None) -> str:
    previous = port.timeout
    if timeout is not None:
        port.timeout = max(float(previous or 0), timeout)
    try:
        port.write((text + "\n").encode("ascii"))
        port.flush()
        response = read_line(port)
        if response.startswith("ERR "):
            raise RuntimeError(f"device rejected {text!r}: {response}")
        return response
    finally:
        port.timeout = previous


def signal_sync(port, info: dict, state: str, batch_id: str) -> None:
    if info["protocol_version"] < 2:
        return
    expected_prefix = {"BEGIN": "SYNC BEGIN", "COMMIT": "SYNC OK", "ERROR": "SYNC ERROR"}[state]
    expected = f"{expected_prefix} {batch_id}"
    response = command(port, f"SYNC {state} {batch_id}")
    if response != expected:
        raise RuntimeError(f"unexpected SYNC response: {response}")


def commit_sync(port, info: dict, batch_id: str) -> int:
    """Commit the batch, tolerating newer queued recordings only."""
    try:
        signal_sync(port, info, "COMMIT", batch_id)
        return 0
    except RuntimeError as error:
        if info["protocol_version"] < 2 or "ERR -16" not in str(error):
            raise
        fields = command(port, "STATUS").split()
        if len(fields) != 3 or fields[0] != "STATUS":
            raise RuntimeError(f"unexpected STATUS response after deferred commit: {' '.join(fields)}") from error
        try:
            pending, session_active = int(fields[1]), int(fields[2])
        except ValueError:
            raise RuntimeError(f"unexpected STATUS response after deferred commit: {' '.join(fields)}") from error
        if pending <= 0 or session_active != 0:
            raise
        return pending


def synchronize_clock(port, info: dict) -> None:
    if info["protocol_version"] < 2:
        return
    offset = datetime.now().astimezone().utcoffset()
    offset_minutes = int(offset.total_seconds() // 60) if offset else 0
    try:
        command(port, f"TIME {time.time_ns() // 1_000_000} {offset_minutes} 100")
    except RuntimeError as error:
        if "ERR -22" not in str(error):
            raise


def list_recordings(port) -> list[tuple[int, int]]:
    port.write(b"LIST\n")
    port.flush()
    recordings = []
    while True:
        fields = read_line(port).split()
        if fields and fields[0] == "ERR":
            raise RuntimeError(" ".join(fields))
        if len(fields) == 2 and fields[0] == "END":
            if int(fields[1]) != len(recordings):
                raise RuntimeError("incomplete LIST response")
            return recordings
        if len(fields) != 3 or fields[0] != "FILE":
            raise RuntimeError(f"unexpected LIST response: {' '.join(fields)}")
        recordings.append((int(fields[1], 16), int(fields[2])))


def pull_one(port, recording_id: int, expected_size: int, destination: Path) -> tuple[int, int]:
    previous = port.timeout
    port.timeout = max(float(previous or 0), 15.0)
    try:
        port.write(f"GET {recording_id:08x}\n".encode("ascii"))
        port.flush()
        fields = read_line(port).split()
        if fields and fields[0] == "ERR":
            raise RuntimeError(" ".join(fields))
        if len(fields) != 4 or fields[0] != "DATA" or int(fields[1], 16) != recording_id:
            raise RuntimeError(f"unexpected GET response: {' '.join(fields)}")
        size, expected_crc = int(fields[2]), int(fields[3], 16)
        if size != expected_size:
            raise RuntimeError(f"recording size changed: LIST={expected_size}, GET={size}")
        payload = bytearray()
        while len(payload) < size:
            chunk = port.read(min(4096, size - len(payload)))
            if not chunk:
                raise TimeoutError(f"download stopped at {len(payload)} of {size} bytes")
            payload.extend(chunk)
        if port.read(1) != b"\n" or read_line(port) != f"DONE {recording_id:08x}":
            raise RuntimeError("invalid recording completion boundary")
    finally:
        port.timeout = previous
    actual_crc = zlib.crc32(payload) & 0xFFFFFFFF
    if actual_crc != expected_crc:
        raise RuntimeError(f"CRC mismatch: expected {expected_crc:08x}, got {actual_crc:08x}")
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_suffix(".part")
    with temporary.open("wb") as output:
        output.write(payload)
        output.flush()
        os.fsync(output.fileno())
    os.replace(temporary, destination)
    fsync_path(destination.parent)
    return size, actual_crc


def parse_mrec(path: Path) -> dict:
    payload = path.read_bytes()
    if len(payload) < MREC_V1.size:
        raise ValueError("recording is shorter than the MREC header")
    magic, version, header_size, session_id = MREC_V1.unpack_from(payload)
    if magic != MREC_MAGIC:
        raise ValueError("invalid MREC magic")
    if version == 1:
        return {"format_version": 1, "header_size": MREC_V1.size, "device_recording_id": session_id,
                "recording_id": session_id, "codec": "opus", "sample_rate_hz": 16000,
                "channel_count": 1, "capture_time": {"valid": False, "source": "unknown"}}
    if version != 2 or header_size < MREC_V2.size or header_size > len(payload):
        raise ValueError(f"invalid MREC version/header: {version}/{header_size}")
    values = MREC_V2.unpack_from(payload)
    capture_valid = bool(values[19] & CAPTURE_TIME_VALID)
    captured_ms = values[16]
    return {
        "format_version": 2, "header_size": header_size, "device_uid": f"{values[4]:016x}",
        "device_recording_id": values[3], "recording_id": values[5],
        "firmware_version": f"{values[6]}.{values[7]}.{values[8]}",
        "codec": CODECS.get(values[10], f"fourcc:{values[10]:08x}"),
        "sample_rate_hz": values[11], "channel_count": values[12], "frame_duration_ms": values[13],
        "boot_id": values[14], "recording_start_uptime_ms": values[15],
        "capture_time": {"valid": capture_valid,
                         "utc": datetime.fromtimestamp(captured_ms / 1000, timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z") if capture_valid else None,
                         "utc_epoch_ms": captured_ms if capture_valid else None,
                         "source": CLOCK_SOURCES.get(values[18], f"source:{values[18]}"),
                         "timezone_offset_minutes": values[17] if capture_valid else None,
                         "uncertainty_ms": values[20] if capture_valid else None}}


def meaningful(text: str) -> bool:
    normalized = " ".join(text.split()).strip()
    if not normalized or normalized.casefold() == "[blank_audio]":
        return False
    return bool(re.sub(r"\[[^]]*\]|\([^)]*\)", "", normalized).strip(" .,!?:;-"))


def write_empty_wav(path: Path) -> None:
    with wave.open(str(path), "wb") as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(16000)
        output.writeframes(b"")


def transcribe_batch(stt: Path, requests: list[dict], env: dict) -> dict[str, dict]:
    payload = "".join(json.dumps(item, separators=(",", ":")) + "\n" for item in requests)
    result = subprocess.run([str(stt), "--batch-transcribe"], input=payload, text=True,
                            capture_output=True, env=env, timeout=max(240, len(requests) * 180))
    rows = {}
    for line in result.stdout.splitlines():
        try:
            row = json.loads(line)
        except ValueError:
            continue
        if row.get("type") == "error":
            message = str(row.get("error") or "")
            if "audio too short" in message.casefold() and isinstance(row.get("id"), str):
                # A button tap can produce a valid MREC/WAV that is shorter than
                # the ASR model's minimum window. Preserve it as a diagnostic
                # recording instead of failing every valid recording in the batch.
                rows[row["id"]] = {
                    "id": row["id"],
                    "text": "",
                    "opusFrames": int(row.get("opusFrames") or 0),
                    "durationSeconds": float(row.get("durationSeconds") or 0.0),
                }
                continue
            raise RuntimeError(f"batch transcription failed for {row.get('id')}: {message}")
        if row.get("type") == "result" and isinstance(row.get("id"), str):
            rows[row["id"]] = row
    if result.returncode != 0:
        raise RuntimeError(f"memo-dictation batch exited {result.returncode}: {result.stderr.strip()[-1000:]}")
    missing = [item["id"] for item in requests if item["id"] not in rows]
    if missing:
        raise RuntimeError(f"memo-dictation returned no result for: {', '.join(missing)}")
    return rows


SCHEMA = """
CREATE TABLE IF NOT EXISTS schema_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS devices(id TEXT PRIMARY KEY,device_uid TEXT NOT NULL UNIQUE,display_name TEXT,firmware_version TEXT,protocol_version INTEGER,first_seen_at TEXT NOT NULL,last_seen_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS clock_syncs(id TEXT PRIMARY KEY,device_id TEXT NOT NULL REFERENCES devices(id),boot_id INTEGER,supplied_utc_ms INTEGER NOT NULL,device_uptime_ms INTEGER,timezone_offset_minutes INTEGER,uncertainty_ms INTEGER NOT NULL,source TEXT NOT NULL,observed_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sync_batches(id TEXT PRIMARY KEY,device_id TEXT NOT NULL REFERENCES devices(id),started_at TEXT NOT NULL,completed_at TEXT,status TEXT NOT NULL CHECK(status IN ('transferring','complete','failed','partial')),total_count INTEGER NOT NULL DEFAULT 0,meaningful_count INTEGER NOT NULL DEFAULT 0,diagnostic_count INTEGER NOT NULL DEFAULT 0,manifest_path TEXT,error TEXT,router_state TEXT NOT NULL DEFAULT 'not_queued' CHECK(router_state IN ('not_queued','pending','claimed','complete','failed')),router_claim_token TEXT,router_claimed_at TEXT,created_at TEXT NOT NULL,router_attempt_count INTEGER NOT NULL DEFAULT 0,router_next_attempt_at TEXT);
CREATE TABLE IF NOT EXISTS locations(id TEXT PRIMARY KEY,latitude REAL NOT NULL,longitude REAL NOT NULL,accuracy_meters REAL,observed_at TEXT NOT NULL,source TEXT NOT NULL,relation TEXT NOT NULL CHECK(relation IN ('capture','sync','other')),age_from_capture_ms INTEGER,created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS recordings(id TEXT PRIMARY KEY,batch_id TEXT REFERENCES sync_batches(id),device_id TEXT NOT NULL REFERENCES devices(id),device_recording_id TEXT NOT NULL,source_crc32 TEXT NOT NULL,source_sha256 TEXT NOT NULL,source_bytes INTEGER NOT NULL,archive_path TEXT NOT NULL,manifest_path TEXT NOT NULL,audio_path TEXT,audio_sha256 TEXT,format_version INTEGER,firmware_version TEXT,codec TEXT,sample_rate_hz INTEGER,channel_count INTEGER,boot_id INTEGER,recording_start_uptime_ms INTEGER,captured_at TEXT,capture_clock_source TEXT,capture_timezone_offset_minutes INTEGER,capture_uncertainty_ms INTEGER,ingested_at TEXT NOT NULL,duration_seconds REAL,opus_frames INTEGER,classification TEXT NOT NULL,location_id TEXT REFERENCES locations(id),UNIQUE(device_id,device_recording_id,source_crc32));
CREATE TABLE IF NOT EXISTS transcripts(id TEXT PRIMARY KEY,recording_id TEXT NOT NULL REFERENCES recordings(id),version INTEGER NOT NULL,text TEXT NOT NULL,text_path TEXT,segments_path TEXT,subtitles_path TEXT,model TEXT NOT NULL,tool TEXT NOT NULL,mean_confidence REAL,created_at TEXT NOT NULL,supersedes_transcript_id TEXT REFERENCES transcripts(id),UNIQUE(recording_id,version));
CREATE TABLE IF NOT EXISTS batch_recordings(batch_id TEXT NOT NULL REFERENCES sync_batches(id),recording_id TEXT NOT NULL REFERENCES recordings(id),position INTEGER NOT NULL,transfer_status TEXT NOT NULL DEFAULT 'committed' CHECK(transfer_status IN ('committed','acknowledged','retained')),PRIMARY KEY(batch_id,recording_id),UNIQUE(batch_id,position));
CREATE TABLE IF NOT EXISTS audit_log(sequence INTEGER PRIMARY KEY AUTOINCREMENT,occurred_at TEXT NOT NULL,actor TEXT NOT NULL,event_type TEXT NOT NULL,entity_type TEXT NOT NULL,entity_id TEXT NOT NULL,from_state TEXT,to_state TEXT,details_json TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS recordings_batch_idx ON recordings(batch_id);
CREATE INDEX IF NOT EXISTS batch_recordings_recording_idx ON batch_recordings(recording_id);
CREATE INDEX IF NOT EXISTS transcripts_recording_idx ON transcripts(recording_id);
CREATE INDEX IF NOT EXISTS batches_router_idx ON sync_batches(router_state,completed_at);
"""


def connect_database(path: Path) -> sqlite3.Connection:
    path.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(path, timeout=30, isolation_level=None)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys=ON")
    connection.execute("PRAGMA journal_mode=WAL")
    connection.execute("PRAGMA synchronous=FULL")
    connection.execute("PRAGMA busy_timeout=30000")
    connection.executescript(SCHEMA)
    columns = {row[1] for row in connection.execute("PRAGMA table_info(sync_batches)")}
    if "router_attempt_count" not in columns:
        connection.execute("ALTER TABLE sync_batches ADD COLUMN router_attempt_count INTEGER NOT NULL DEFAULT 0")
    if "router_next_attempt_at" not in columns:
        connection.execute("ALTER TABLE sync_batches ADD COLUMN router_next_attempt_at TEXT")
    connection.execute("INSERT OR REPLACE INTO schema_meta(key,value) VALUES('schema_version','2')")
    return connection


def audit(connection, event: str, entity_type: str, entity_id: str, to_state=None, details=None) -> None:
    connection.execute("INSERT INTO audit_log(occurred_at,actor,event_type,entity_type,entity_id,from_state,to_state,details_json) VALUES(?,?,?,?,?,?,?,?)",
                       (utc_now(), "memo-desktop", event, entity_type, entity_id, None, to_state, json.dumps(details or {}, sort_keys=True, separators=(",", ":"))))


def durable_checkpoint(connection, database: Path) -> None:
    connection.execute("PRAGMA wal_checkpoint(FULL)")
    if database.exists():
        fsync_path(database)
    fsync_path(database.parent)


def commit_local_batch(connection, database: Path, batch: dict, archives: list[dict]) -> None:
    now = utc_now()
    connection.execute("BEGIN IMMEDIATE")
    try:
        row = connection.execute("SELECT id FROM devices WHERE device_uid=?", (batch["device_uid"],)).fetchone()
        if row:
            device_id = row["id"]
            connection.execute("UPDATE devices SET firmware_version=COALESCE(?,firmware_version),protocol_version=?,last_seen_at=? WHERE id=?",
                               (batch.get("firmware_version"), batch["protocol_version"], now, device_id))
        else:
            device_id = str(uuid.uuid4())
            connection.execute("INSERT INTO devices(id,device_uid,firmware_version,protocol_version,first_seen_at,last_seen_at) VALUES(?,?,?,?,?,?)",
                               (device_id, batch["device_uid"], batch.get("firmware_version"), batch["protocol_version"], now, now))
            audit(connection, "device.discovered", "device", device_id, "known", {"uid": batch["device_uid"]})
        batch_exists = connection.execute("SELECT 1 FROM sync_batches WHERE id=?", (batch["batch_id"],)).fetchone() is not None
        connection.execute("INSERT OR IGNORE INTO sync_batches(id,device_id,started_at,status,created_at) VALUES(?,?,?,?,?)",
                           (batch["batch_id"], device_id, batch["started_at"], "transferring", batch["started_at"]))
        for position, item in enumerate(archives, 1):
            existing = connection.execute("SELECT id,archive_path FROM recordings WHERE device_id=? AND device_recording_id=? AND source_sha256=?",
                                          (device_id, item["device_recording_id"], item["manifest"]["source_sha256"])).fetchone()
            if existing:
                if not Path(existing["archive_path"]).is_dir():
                    raise RuntimeError("an indexed recording is missing its durable archive")
                recording_uuid = existing["id"]
            else:
                recording_uuid = str(uuid.uuid4())
                manifest = item["manifest"]
                container = manifest["container"]
                capture = container.get("capture_time") or {}
                archive = Path(item["archive_path"])
                audio_path = archive / "audio.wav"
                connection.execute("""INSERT INTO recordings(id,batch_id,device_id,device_recording_id,source_crc32,source_sha256,source_bytes,archive_path,manifest_path,audio_path,audio_sha256,format_version,firmware_version,codec,sample_rate_hz,channel_count,boot_id,recording_start_uptime_ms,captured_at,capture_clock_source,capture_timezone_offset_minutes,capture_uncertainty_ms,ingested_at,duration_seconds,opus_frames,classification) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                    (recording_uuid, batch["batch_id"], device_id, item["device_recording_id"], item["source_crc32"], manifest["source_sha256"], manifest["source_bytes"], str(archive), str(archive / "manifest.json"), str(audio_path) if audio_path.exists() else None, manifest.get("audio_sha256"), container.get("format_version"), container.get("firmware_version") or batch.get("firmware_version"), container.get("codec"), container.get("sample_rate_hz"), container.get("channel_count"), container.get("boot_id"), container.get("recording_start_uptime_ms"), capture.get("utc") if capture.get("valid") else None, capture.get("source") if capture.get("valid") else "unknown", capture.get("timezone_offset_minutes") if capture.get("valid") else None, capture.get("uncertainty_ms") if capture.get("valid") else None, manifest["ingested_at"], manifest["duration_seconds"], manifest["opus_frames"], manifest["classification"]))
                connection.execute("INSERT INTO transcripts(id,recording_id,version,text,text_path,segments_path,subtitles_path,model,tool,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
                    (str(uuid.uuid4()), recording_uuid, 1, manifest["transcript"], str(archive / "transcript.txt"), str(archive / "transcript.json"), str(archive / "transcript.srt"), manifest["transcription_model"], manifest["transcription_tool"], manifest["ingested_at"]))
                audit(connection, "recording.committed", "recording", recording_uuid, "indexed", {"batch_id": batch["batch_id"], "device_recording_id": item["device_recording_id"], "archive_path": str(archive)})
            connection.execute("INSERT OR IGNORE INTO batch_recordings(batch_id,recording_id,position,transfer_status) VALUES(?,?,?,'committed')",
                               (batch["batch_id"], recording_uuid, position))
        if not batch_exists:
            audit(connection, "batch.started", "sync_batch", batch["batch_id"], "transferring", {"device_uid": batch["device_uid"]})
        connection.commit()
    except Exception:
        connection.rollback()
        raise
    durable_checkpoint(connection, database)


def complete_batch(connection, database: Path, batch: dict, journal: dict, batch_dir: Path) -> None:
    current = connection.execute("SELECT status FROM sync_batches WHERE id=?", (batch["batch_id"],)).fetchone()
    if not current:
        raise RuntimeError("refusing to complete a batch that is not durably indexed")
    if current and current["status"] == "complete":
        durable_checkpoint(connection, database)
        return
    rows = connection.execute("SELECT r.classification,COUNT(*) count FROM recordings r JOIN batch_recordings br ON br.recording_id=r.id WHERE br.batch_id=? GROUP BY r.classification", (batch["batch_id"],)).fetchall()
    counts = {row["classification"]: row["count"] for row in rows}
    total = sum(counts.values())
    meaningful_count = counts.get("audio", 0)
    completed = utc_now()
    manifest_path = batch_dir / f"{batch['batch_id']}.json"
    connection.execute("BEGIN IMMEDIATE")
    try:
        connection.execute("UPDATE sync_batches SET completed_at=?,status='complete',total_count=?,meaningful_count=?,diagnostic_count=?,manifest_path=?,router_state=?,error=NULL WHERE id=?",
                           (completed, total, meaningful_count, total - meaningful_count, str(manifest_path), "pending" if meaningful_count else "not_queued", batch["batch_id"]))
        connection.execute("UPDATE batch_recordings SET transfer_status='acknowledged' WHERE batch_id=?", (batch["batch_id"],))
        audit(connection, "batch.committed", "sync_batch", batch["batch_id"], "complete", {"total": total, "meaningful": meaningful_count})
        connection.commit()
    except Exception:
        connection.rollback()
        raise
    atomic_json(manifest_path, {"schema_version": 1, "batch_id": batch["batch_id"], "device": {"uid": batch["device_uid"], "firmware_version": batch.get("firmware_version"), "protocol_version": batch["protocol_version"]}, "status": "complete", "started_at": batch["started_at"], "completed_at": completed, "counts": {"total": total, "meaningful": meaningful_count, "diagnostic": total - meaningful_count}, "recordings": journal["recordings"]})
    durable_checkpoint(connection, database)


def existing_archive(connection, device_uid: str, recording_id: str, source_sha256: str) -> dict | None:
    row = connection.execute("""SELECT r.archive_path,r.source_sha256,r.classification,r.duration_seconds,r.ingested_at,r.captured_at,t.text FROM recordings r JOIN devices d ON d.id=r.device_id LEFT JOIN transcripts t ON t.recording_id=r.id AND t.version=(SELECT MAX(t2.version) FROM transcripts t2 WHERE t2.recording_id=r.id) WHERE d.device_uid=? AND r.device_recording_id=? AND r.source_sha256=?""", (device_uid, recording_id, source_sha256)).fetchone()
    return dict(row) if row and Path(row["archive_path"]).is_dir() else None


def unacknowledged_batch_ids(port, journal: dict) -> list[str]:
    batch_ids = {item["id"] for item in journal["recordings"]}
    remaining_ids = {f"{recording_id:08x}" for recording_id, _ in list_recordings(port)}
    return sorted(batch_ids & remaining_ids)


def journal_item_has_durable_copy(item: dict) -> bool:
    source = Path(item.get("stage", "")) / "source.mrec"
    source_valid = (
        source.is_file()
        and bool(item.get("crc32"))
        and f"{zlib.crc32(source.read_bytes()) & 0xFFFFFFFF:08x}" == item["crc32"]
    )
    if source_valid:
        return True
    return archive_is_valid(item)


def archive_is_valid(item: dict) -> bool:
    try:
        validate_archive(item)
        return True
    except (OSError, RuntimeError, ValueError):
        return False


def validate_archive(item: dict) -> dict:
    archive = Path(item.get("archive_path", ""))
    manifest_path = archive / "manifest.json"
    if not manifest_path.is_file():
        raise RuntimeError("refusing to acknowledge a recording whose durable archive is missing")
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        raise RuntimeError("refusing to acknowledge a recording whose archive manifest is invalid") from error
    source = archive / "source.mrec"
    audio = archive / "audio.wav"
    expected_crc = item.get("crc32")
    if (
        manifest.get("status") != "complete"
        or not expected_crc
        or manifest.get("source_crc32") != expected_crc
        or not source.is_file()
        or f"{zlib.crc32(source.read_bytes()) & 0xFFFFFFFF:08x}" != expected_crc
        or manifest.get("source_sha256") != sha256(source)
        or not audio.is_file()
        or manifest.get("audio_sha256") != sha256(audio)
    ):
        raise RuntimeError("refusing to acknowledge a recording whose durable archive is invalid")
    return manifest


def prepare_archives(args, connection, batch: dict, journal: dict) -> list[dict]:
    requests = []
    results = {}
    for item in journal["recordings"]:
        local_archive = Path(item["archive_path"]) if item.get("archive_path") else None
        if local_archive and archive_is_valid(item):
            local_manifest = validate_archive(item)
            item["source_sha256"] = local_manifest["source_sha256"]
            item["reused"] = True
            continue
        source = Path(item["stage"]) / "source.mrec"
        item["source_sha256"] = item.get("source_sha256") or sha256(source)
        prior = existing_archive(connection, batch["device_uid"], item["id"], item["source_sha256"])
        if prior:
            item["archive_path"] = prior["archive_path"]
            item["source_sha256"] = prior["source_sha256"]
            if archive_is_valid(item):
                item["reused"] = True
                atomic_json(args.journal, journal)
                continue
        stage = Path(item["stage"])
        if item["size"] > 0:
            requests.append({"id": item["id"], "input": str(stage / "source.mrec"), "wav": str(stage / "audio.wav")})
    if requests:
        emit("transcribing", batchId=batch["batch_id"], completed=0, total=len(requests), requestedModel=args.requested_model, actualModel=args.actual_model, transport=journal.get("last_transport"), endpoint=journal.get("last_endpoint"))
        await_transcription_slot()
        env = dict(os.environ)
        env.update({"MEMO_ASR_BACKEND": args.actual_model, "PYTHONNOUSERSITE": "1"})
        if args.actual_model == "whisper":
            env["MEMO_WHISPER_MODEL_PATH"] = str(args.whisper_model)
        else:
            env["MEMO_ASR_WORKER"] = str(args.conomo_root / "conomo")
        results = transcribe_batch(args.stt_bin, requests, env)
    archives = []
    completed = 0
    for item in journal["recordings"]:
        if item.get("reused"):
            manifest = validate_archive(item)
        else:
            stage = Path(item["stage"])
            row = results.get(item["id"], {"text": "", "opusFrames": 0, "durationSeconds": 0.0})
            text = row["text"].strip()
            source = stage / "source.mrec"
            wav = stage / "audio.wav"
            if item["size"] == 0:
                write_empty_wav(wav)
                container = {"format_version": None, "device_recording_id": int(item["id"], 16), "capture_time": {"valid": False, "source": "unknown"}}
                classification = "empty_device_artifact"
            else:
                container = parse_mrec(source)
                if int(container["device_recording_id"]) != int(item["id"], 16):
                    raise RuntimeError("MREC recording ID does not match the USB directory")
                classification = "audio" if meaningful(text) else ("no_audio" if row["opusFrames"] == 0 else "no_speech")
            ingested_at = utc_now()
            (stage / "transcript.txt").write_text(text + ("\n" if text else ""), encoding="utf-8")
            (stage / "transcript.json").write_text(json.dumps({"result": {"text": text, "segments": []}}, indent=2) + "\n", encoding="utf-8")
            (stage / "transcript.srt").write_text("", encoding="utf-8")
            manifest = {"status": "complete", "device_recording_id": item["id"], "source_bytes": item["size"], "source_crc32": item["crc32"], "source_sha256": sha256(source), "audio_sha256": sha256(wav), "duration_seconds": round(row["durationSeconds"], 3), "opus_frames": row["opusFrames"], "requested_model": args.requested_model, "actual_model": args.actual_model, "fallback_reason": args.fallback_reason, "transcription_model": args.actual_model, "transcription_tool": "memo-dictation-batch", "transcript": text, "classification": classification, "ingested_at": ingested_at, "container": container}
            atomic_json(stage / "manifest.json", manifest)
            for child in stage.iterdir():
                if child.is_file():
                    fsync_path(child)
            timestamp = datetime.now().astimezone().strftime("%Y-%m-%d_%H-%M-%S")
            final = args.library / f"{timestamp}_memo_{item['id']}"
            if final.exists():
                final = args.library / f"{timestamp}_memo_{item['id']}_{manifest['source_sha256'][:8]}"
            os.replace(stage, final)
            fsync_path(args.library)
            item["archive_path"] = str(final)
            item["source_sha256"] = manifest["source_sha256"]
            atomic_json(args.journal, journal)
        archives.append({"device_recording_id": item["id"], "source_crc32": item["crc32"], "archive_path": item["archive_path"], "manifest": manifest})
        completed += 1
        emit("transcribing", batchId=batch["batch_id"], completed=completed, total=len(journal["recordings"]), requestedModel=args.requested_model, actualModel=args.actual_model, transport=journal.get("last_transport"), endpoint=journal.get("last_endpoint"))
    return archives


def resume_ack(port, info: dict, args, connection, journal: dict, transport: str = "usb", endpoint: str = "USB") -> None:
    if journal.get("device_uid") != info["device_uid"]:
        raise RuntimeError("a different Memo is connected while a sync batch is awaiting acknowledgement")
    batch = {key: journal[key] for key in ("batch_id", "device_uid", "protocol_version", "firmware_version", "started_at")}
    archives = [
        {
            "device_recording_id": item["id"],
            "source_crc32": item["crc32"],
            "archive_path": item["archive_path"],
            "manifest": validate_archive(item),
        }
        for item in journal["recordings"]
    ]
    commit_local_batch(connection, args.database, batch, archives)
    remaining = {f"{recording_id:08x}" for recording_id, _ in list_recordings(port)}
    journal["phase"] = "acking"
    atomic_json(args.journal, journal)
    for index, item in enumerate(journal["recordings"]):
        if item["id"] in remaining:
            response = command(port, f"ACK {item['id']} {item['crc32']}", timeout=15)
            if response != f"OK {item['id']}":
                raise RuntimeError(f"unexpected ACK response: {response}")
        item["acknowledged"] = True
        atomic_json(args.journal, journal)
        emit("verifying", batchId=journal["batch_id"], completed=index + 1, total=len(journal["recordings"]), transport=transport, endpoint=endpoint)
    unacknowledged = unacknowledged_batch_ids(port, journal)
    if unacknowledged:
        raise RuntimeError(f"batch recordings remain after acknowledgements: {', '.join(unacknowledged)}")
    batch = {key: journal[key] for key in ("batch_id", "device_uid", "protocol_version", "firmware_version", "started_at")}
    complete_batch(connection, args.database, batch, journal, args.batch_directory)
    rows = connection.execute("""SELECT r.source_sha256,d.device_uid,r.device_recording_id,r.captured_at,r.ingested_at,r.duration_seconds,r.audio_path,t.text transcript FROM recordings r JOIN devices d ON d.id=r.device_id JOIN transcripts t ON t.recording_id=r.id AND t.version=(SELECT MAX(t2.version) FROM transcripts t2 WHERE t2.recording_id=r.id) JOIN batch_recordings br ON br.recording_id=r.id WHERE br.batch_id=? AND r.classification='audio' AND trim(t.text)<>'' ORDER BY br.position""", (journal["batch_id"],)).fetchall()
    for row in rows:
        emit_recording(dict(row))
    pending_on_device = commit_sync(port, info, journal["batch_id"])
    journal["phase"] = "complete"
    atomic_json(args.journal, journal)
    emit("complete", batchId=journal["batch_id"], completed=len(journal["recordings"]), total=len(journal["recordings"]), requestedModel=args.requested_model, actualModel=args.actual_model, pendingOnDevice=pending_on_device, transport=transport, endpoint=endpoint)


def process_device(port, info: dict, endpoint: str, args, connection, transport: str = "usb") -> None:
    if args.journal.exists():
        try:
            journal = json.loads(args.journal.read_text(encoding="utf-8"))
        except (OSError, ValueError) as error:
            raise RuntimeError("refusing to overwrite an unreadable interrupted sync journal") from error
        if not isinstance(journal, dict) or journal.get("phase") not in {"pulling", "transcribing", "durable", "acking", "complete"}:
            raise RuntimeError("refusing to overwrite an invalid interrupted sync journal")
        if journal.get("phase") in {"durable", "acking"}:
            emit("verifying", batchId=journal.get("batch_id"), completed=0, total=len(journal.get("recordings", [])), deviceUid=info["device_uid"], transport=transport, endpoint=endpoint)
            resume_ack(port, info, args, connection, journal, transport, endpoint)
            return
        if journal.get("phase") in {"pulling", "transcribing"} and journal.get("device_uid") == info["device_uid"]:
            device_recordings = dict(list_recordings(port))
            missing_items = [
                item for item in journal.get("recordings", [])
                if int(item["id"], 16) not in device_recordings
            ]
            if any(not journal_item_has_durable_copy(item) for item in missing_items):
                raise RuntimeError("device contents changed before the interrupted batch became durable")
            batch = {key: journal[key] for key in ("batch_id", "device_uid", "protocol_version", "firmware_version", "started_at")}
            signal_sync(port, info, "BEGIN", journal["batch_id"])
            emit("transferring", batchId=journal["batch_id"], deviceUid=info["device_uid"], transport=transport, endpoint=endpoint, completed=0, total=len(journal["recordings"]))
            for index, item in enumerate(journal["recordings"]):
                source = Path(item["stage"]) / "source.mrec"
                source_valid = source.is_file() and item.get("crc32") and f"{zlib.crc32(source.read_bytes()) & 0xFFFFFFFF:08x}" == item["crc32"]
                archive_valid = archive_is_valid(item)
                if not source_valid and not archive_valid:
                    size, crc32 = pull_one(port, int(item["id"], 16), device_recordings[int(item["id"], 16)], source)
                    item.update({"size": size, "crc32": f"{crc32:08x}"})
                    atomic_json(args.journal, journal)
                emit("transferring", batchId=journal["batch_id"], deviceUid=info["device_uid"], transport=transport, endpoint=endpoint, completed=index + 1, total=len(journal["recordings"]))
            journal["phase"] = "transcribing"
            atomic_json(args.journal, journal)
            archives = prepare_archives(args, connection, batch, journal)
            commit_local_batch(connection, args.database, batch, archives)
            journal["phase"] = "durable"
            atomic_json(args.journal, journal)
            journal["last_transport"] = transport
            journal["last_endpoint"] = endpoint
            atomic_json(args.journal, journal)
            resume_ack(port, info, args, connection, journal, transport, endpoint)
            return
        if journal.get("phase") in {"pulling", "transcribing"}:
            raise RuntimeError("a different Memo is connected while an interrupted sync batch is pending")
    synchronize_clock(port, info)
    recordings = sorted(list_recordings(port))
    if not recordings:
        emit(
            "connected",
            deviceUid=info["device_uid"],
            firmwareVersion=info.get("firmware_version"),
            protocolVersion=info["protocol_version"],
            port=endpoint if transport == "usb" else None,
            transport=transport,
            endpoint=endpoint,
            completed=0,
            total=0,
        )
        return
    batch_id = str(uuid.uuid4())
    started_at = utc_now()
    batch = {"batch_id": batch_id, "device_uid": info["device_uid"], "protocol_version": info["protocol_version"], "firmware_version": info.get("firmware_version"), "started_at": started_at}
    stage_root = args.library / ".staging" / batch_id
    journal = {**batch, "phase": "pulling", "last_transport": transport, "last_endpoint": endpoint, "recordings": [{"id": f"{recording_id:08x}", "reported_size": size, "stage": str(stage_root / f"{recording_id:08x}"), "acknowledged": False} for recording_id, size in recordings]}
    atomic_json(args.journal, journal)
    signal_sync(port, info, "BEGIN", batch_id)
    emit("transferring", batchId=batch_id, deviceUid=info["device_uid"], transport=transport, endpoint=endpoint, completed=0, total=len(recordings))
    for index, ((recording_id, reported_size), item) in enumerate(zip(recordings, journal["recordings"])):
        source = Path(item["stage"]) / "source.mrec"
        size, crc32 = pull_one(port, recording_id, reported_size, source)
        item.update({"size": size, "crc32": f"{crc32:08x}"})
        atomic_json(args.journal, journal)
        emit("transferring", batchId=batch_id, deviceUid=info["device_uid"], transport=transport, endpoint=endpoint, completed=index + 1, total=len(recordings))
    journal["phase"] = "transcribing"
    atomic_json(args.journal, journal)
    archives = prepare_archives(args, connection, batch, journal)
    commit_local_batch(connection, args.database, batch, archives)
    journal["phase"] = "durable"
    atomic_json(args.journal, journal)
    resume_ack(port, info, args, connection, journal, transport, endpoint)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--database", type=Path, required=True)
    parser.add_argument("--library", type=Path, required=True)
    parser.add_argument("--batch-directory", type=Path, required=True)
    parser.add_argument("--journal", type=Path, required=True)
    parser.add_argument("--trusted-device", type=Path, required=True)
    parser.add_argument("--lock", type=Path, required=True)
    parser.add_argument("--stt-bin", type=Path, required=True)
    parser.add_argument("--conomo-root", type=Path, required=True)
    parser.add_argument("--whisper-model", type=Path, required=True)
    parser.add_argument("--requested-model", choices=("conomo", "whisper"), required=True)
    parser.add_argument("--actual-model", choices=("conomo", "whisper"), required=True)
    parser.add_argument("--fallback-reason", default=None)
    parser.add_argument("--poll-seconds", type=float, default=2.0)
    parser.add_argument("--ble-bridge", type=Path)
    args = parser.parse_args()
    args.library.mkdir(parents=True, exist_ok=True)
    args.batch_directory.mkdir(parents=True, exist_ok=True)
    args.lock.parent.mkdir(parents=True, exist_ok=True)
    lock_file = args.lock.open("a+")
    try:
        fcntl.flock(lock_file, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        emit("error", error="Another Memo desktop sync owner is already running.", code="owner-conflict")
        return 2
    connection = connect_database(args.database)
    last_state = None
    last_error = None
    try:
        while True:
            try:
                port, info, endpoint, transport = open_sync_transport(args.ble_bridge, args.trusted_device)
            except RuntimeError as error:
                if last_state != "error" or str(error) != last_error:
                    emit("error", error=str(error), transport="ble", endpoint="Bluetooth")
                last_state = "error"
                last_error = str(error)
                time.sleep(args.poll_seconds)
                continue
            if port is None:
                if last_state != "disconnected":
                    emit("disconnected")
                    last_state = "disconnected"
                    last_error = None
                time.sleep(args.poll_seconds)
                continue
            try:
                if transport == "usb":
                    remember_usb_device(args.trusted_device, info)
                process_device(port, info, endpoint, args, connection, transport)
                last_state = "connected"
                last_error = None
            except (OSError, SerialException, TimeoutError) as error:
                emit("disconnected", error=str(error), transport=transport, endpoint=endpoint)
                last_state = "disconnected"
            except Exception as error:
                emit("error", error=str(error), deviceUid=info.get("device_uid") if info else None, transport=transport, endpoint=endpoint)
                try:
                    if info and args.journal.exists():
                        failed = json.loads(args.journal.read_text(encoding="utf-8"))
                        if failed.get("batch_id"):
                            signal_sync(port, info, "ERROR", failed["batch_id"])
                except Exception:
                    pass
                last_state = "error"
            finally:
                port.close()
            time.sleep(args.poll_seconds)
    finally:
        connection.close()


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        raise SystemExit(0)
