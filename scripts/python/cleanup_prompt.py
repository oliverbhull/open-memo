"""Versioned inference prompt, independent of local training experiments.

Keep the trained prompt byte-for-byte stable. Its historical placeholder wording
is part of that prompt; inference passes plain text and adds no placeholders.
"""

PROMPT_VERSION = "memo-lfm-hybrid-v3"
INSTRUCTION = (
    "Edit this dictated transcript into clear, natural written English. "
    "Remove filler words, accidental repetition, and superseded corrections. "
    "Keep every fact, name, relationship, negation, and protected placeholder unchanged. "
    "Return only the edited text."
)


def user_content(transcript: str) -> str:
    return f"{INSTRUCTION}\n\nTranscript: {transcript}"
