"""Exercise real model residency and pipe framing (no microphone required).

python test-whisper-worker.py WORKER MODEL MONO_16KHZ_WAV [EXPECTED_WORD]
"""
import io
import json
import struct
import subprocess
import sys
import threading
import time
import wave


def read_exact(stream, size):
    result = bytearray()
    while len(result) < size:
        chunk = stream.read(size - len(result))
        if not chunk:
            raise RuntimeError("worker pipe closed before complete response")
        result.extend(chunk)
    return bytes(result)


def response(process):
    status, length = struct.unpack("<BI", read_exact(process.stdout, 5))
    if length > 4 * 1024 * 1024:
        raise RuntimeError("invalid response size")
    text = read_exact(process.stdout, length).decode("utf-8")
    if status != 0:
        raise RuntimeError(text)
    return text


def main():
    executable, model, audio = sys.argv[1:4]
    expected = sys.argv[4] if len(sys.argv) > 4 else "country"
    with wave.open(audio) as wav:
        assert (wav.getframerate(), wav.getnchannels(), wav.getsampwidth()) == (16000, 1, 2)
        pcm = wav.readframes(wav.getnframes())
    with subprocess.Popen([executable, model], stdin=subprocess.PIPE, stdout=subprocess.PIPE) as process:
        timer = threading.Timer(240, process.kill)
        timer.start()
        try:
            started = time.perf_counter()
            assert response(process) == ""
            loaded_seconds = time.perf_counter() - started
            texts, durations = [], []
            for _ in range(2):
                started = time.perf_counter()
                process.stdin.write(struct.pack("<I", len(pcm) // 2) + pcm)
                process.stdin.flush()
                text = " ".join(response(process).split())
                durations.append(time.perf_counter() - started)
                assert expected.lower() in text.lower(), text
                texts.append(text)
                assert process.poll() is None, "worker exited instead of keeping the model loaded"
            assert texts[0] == texts[1], "context from the earlier request changed the result"
            process.stdin.close()
            assert process.wait(timeout=10) == 0
            print(json.dumps({"load_seconds": loaded_seconds, "inference_seconds": durations,
                              "pid": process.pid, "transcript": texts[0]}, indent=2))
        finally:
            timer.cancel()
            if process.poll() is None:
                process.kill()
                process.wait()
    for malformed, reason in [
        (b"\x01\x00", "Truncated request header"),
        (struct.pack("<I", 10) + b"\x00\x00", "Truncated PCM audio"),
        (struct.pack("<I", 16000 * 60 * 10 + 1), "Audio exceeds ten minutes"),
    ]:
        failed = subprocess.run([executable, model], input=malformed,
                                stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=120)
        assert failed.returncode != 0, reason
        stream = io.BytesIO(failed.stdout)
        assert struct.unpack("<BI", read_exact(stream, 5)) == (0, 0)
        status, length = struct.unpack("<BI", read_exact(stream, 5))
        assert status == 1 and read_exact(stream, length).decode("utf-8") == reason
    print("Malformed and truncated requests rejected cleanly.")


if __name__ == "__main__":
    main()
