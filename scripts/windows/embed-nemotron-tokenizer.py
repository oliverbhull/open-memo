"""Add a SentencePiece tokenizer to the pinned GGUF without changing its tensors."""

import base64
import hashlib
import shutil
import struct
import sys
import tarfile
from pathlib import Path


def read_number(stream, fmt):
    return struct.unpack(fmt, stream.read(struct.calcsize(fmt)))[0]


def read_string(stream):
    return stream.read(read_number(stream, "<Q"))


def skip_value(stream, kind):
    widths = {0: 1, 1: 1, 2: 2, 3: 2, 4: 4, 5: 4, 6: 4, 7: 1, 10: 8, 11: 8, 12: 8}
    if kind == 8:  # String
        length = read_number(stream, "<Q")
        stream.seek(length, 1)
    elif kind == 9:  # Array
        element_kind = read_number(stream, "<I")
        length = read_number(stream, "<Q")
        if element_kind in widths:
            stream.seek(length * widths[element_kind], 1)
        else:
            for _ in range(length):
                skip_value(stream, element_kind)
    else:
        stream.seek(widths[kind], 1)


def embed(source, archive, output):
    # The verified member fits near the start of the uncompressed NeMo tar.
    with tarfile.open(archive, "r|") as checkpoint:
        for member in checkpoint:
            if member.name == "./e8dc9587bf16427491071501d9080e4e_tokenizer.model":
                tokenizer = checkpoint.extractfile(member).read()
                break
        else:
            raise ValueError("Missing Nemotron SentencePiece tokenizer")
    if hashlib.sha256(tokenizer).hexdigest() != "07d4e5a63840a53ab2d4d106d2874768143fb3fbdd47938b3910d2da05bfb0a9":
        raise ValueError("Nemotron tokenizer checksum mismatch")

    def aligned(offset):
        return (offset + alignment - 1) // alignment * alignment

    def string(value):
        return struct.pack("<Q", len(value)) + value

    with source.open("rb") as model, output.open("wb") as result:
        magic, version, tensors, fields = struct.unpack("<4sIQQ", model.read(24))
        if magic != b"GGUF" or version != 3:
            raise ValueError("Expected a GGUF v3 model")
        alignment = 32
        for _ in range(fields):
            key = read_string(model)
            kind = read_number(model, "<I")
            if key == b"asr.tokenizer.spm_model":
                raise ValueError("Tokenizer is already embedded")
            if key == b"general.alignment" and kind == 4:
                alignment = read_number(model, "<I")
            else:
                skip_value(model, kind)
        metadata_end = model.tell()
        for _ in range(tensors):
            read_string(model)  # Tensor name
            dimensions = read_number(model, "<I")
            model.seek(dimensions * 8 + 4 + 8, 1)  # Shape, type and data-relative offset
        tensor_info_end = model.tell()

        result.write(struct.pack("<4sIQQ", magic, version, tensors, fields + 1))
        model.seek(24)
        result.write(model.read(metadata_end - 24))
        result.write(string(b"asr.tokenizer.spm_model"))
        result.write(struct.pack("<I", 8))  # GGUF string
        result.write(string(base64.b64encode(tokenizer)))
        result.write(model.read(tensor_info_end - metadata_end))
        result.write(b"\0" * (aligned(result.tell()) - result.tell()))
        model.seek(aligned(tensor_info_end))
        shutil.copyfileobj(model, result, length=1024 * 1024)


if __name__ == "__main__":
    embed(*map(Path, sys.argv[1:]))
