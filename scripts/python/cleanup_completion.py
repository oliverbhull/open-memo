"""Read a complete MLX response without accepting a token-limit cutoff."""

import re


class WordingChanged(ValueError):
    """Formatting changed words, their order, or a numeric value."""


# Allow unambiguous contractions, but not ambiguous 's / 'd expansions.
CONTRACTIONS = {
    "i'm": "i am", "you're": "you are", "we're": "we are", "they're": "they are",
    "i've": "i have", "you've": "you have", "we've": "we have", "they've": "they have",
    "i'll": "i will", "you'll": "you will", "we'll": "we will", "they'll": "they will",
    "don't": "do not", "doesn't": "does not", "didn't": "did not",
    "isn't": "is not", "aren't": "are not", "wasn't": "was not", "weren't": "were not",
    "can't": "can not", "cannot": "can not", "won't": "will not",
    "couldn't": "could not", "wouldn't": "would not", "shouldn't": "should not",
    "haven't": "have not", "hasn't": "has not", "hadn't": "had not",
}


def wording_tokens(text: str) -> list[str]:
    tokens = re.findall(r"[+-]?\d+(?:[.,]\d+)*|\w+(?:'\w+)*|[%$£€=<>/@#&]",
                        text.replace("’", "'").casefold())
    return [word for token in tokens for word in CONTRACTIONS.get(token, token).split()]


def require_preserved_wording(source: str, candidate: str) -> None:
    """Offline evaluation diagnostic only; never used to gate delivered dictation.

    Accept casing/layout/punctuation and removal of standalone um/uh only.

    This is deliberately a wording check, not a claim of semantic equivalence.
    A retained word count cannot catch changed subjects or a missing negation.
    """
    original, edited = wording_tokens(source), wording_tokens(candidate)
    index = 0
    for word in original:
        if index < len(edited) and word == edited[index]:
            index += 1
        elif word not in {"um", "uh"}:
            raise WordingChanged("cleanup changed or omitted dictated words")
    if index != len(edited):
        raise WordingChanged("cleanup added dictated words")


def output_token_budget(source_token_count: int) -> int:
    # Long dictation needs room to reproduce the source plus punctuation.
    return min(8192, max(64, source_token_count * 5 // 4 + 64))


class IncompleteGeneration(ValueError):
    """Generation stopped at a limit rather than the model's end marker."""


def complete_output(responses) -> str:
    parts = []
    finish_reason = None
    for response in responses:
        parts.append(response.text)
        finish_reason = response.finish_reason
    if finish_reason != "stop":
        raise IncompleteGeneration("generation did not finish")
    return "".join(parts).strip()
