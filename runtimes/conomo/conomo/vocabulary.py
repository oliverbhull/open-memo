"""Rescore saved spelling candidates with the RNN-T over the same audio span."""

from bisect import bisect_left
from dataclasses import dataclass
import math
import re
import unicodedata

import numpy as np


WORD = re.compile(r"[^\W_]+(?:[.’'_-][^\W_]+)*[+#]*")
BOUNDARY = '▁'

# Tune on positive examples and confusable ordinary speech. These are whole
# word log-likelihood budgets, independent of the number of emitted tokens.
NAME_LOG_PRIOR = 10.5
WORD_LOG_PRIOR = 3.0
ONE_EDIT_LOG_PRIOR = 11.0
MAX_NEIGHBORS = 2
ALIGNMENT_MARGIN = 2
MAX_FRAMES = 4096
MAX_JOINER_ROWS = 256


def vocabulary_strength(value):
    """An optional caller-supplied ceiling on the automatic preference."""
    if value is None:
        return None
    strength = float(value)
    if not np.isfinite(strength) or strength < 0:
        raise ValueError('Vocabulary strength must be finite and nonnegative')
    return strength


def compact(text):
    normalized = unicodedata.normalize('NFKC', text).casefold()
    return ''.join(char for char in normalized if char.isalnum())


def spelling_key(text):
    return ' '.join(unicodedata.normalize('NFKC', text).casefold().split())


def edit_distance(left, right, limit):
    outside = limit + 1
    if abs(len(left) - len(right)) > limit:
        return outside
    previous = {column: column for column in range(min(len(right), limit) + 1)}
    for index, a in enumerate(left, 1):
        row = {0: index} if index <= limit else {}
        for column in range(max(1, index - limit), min(len(right), index + limit) + 1):
            row[column] = min(
                row.get(column - 1, outside) + 1,
                previous.get(column, outside) + 1,
                previous.get(column - 1, outside) + (a != right[column - 1]),
            )
        if min(row.values(), default=outside) > limit:
            return outside
        previous = row
    return min(previous.get(len(right), outside), outside)


@dataclass(frozen=True)
class Entry:
    spelling: str
    key: str
    words: int


class Vocabulary:
    def __init__(self, phrases):
        self.phrases = tuple(dict.fromkeys(phrases))
        self.entries = {}
        self.by_length = {}
        self.max_words = 1
        for phrase in self.phrases:
            spelling = phrase.strip()
            key = compact(spelling)
            exact = spelling_key(spelling)
            if not key or exact in self.entries:
                continue
            words = len(WORD.findall(spelling))
            entry = Entry(spelling, key, words)
            self.entries[exact] = entry
            self.max_words = max(self.max_words, words + spelling.count('-') + spelling.count('_') + 1)
            self.by_length.setdefault(len(key), []).append(entry)

    def __bool__(self):
        return bool(self.entries)

    def candidates(self, key, words):
        # An edit can be anywhere in the word. The joiner evaluates each
        # proposal on the original audio.
        candidates = []
        for term_length in range(max(1, len(key) - 2), len(key) + 3):
            length = max(len(key), term_length)
            limit = min(2, int(length * 0.4)) if length >= 4 else 0
            for entry in self.by_length.get(term_length, ()):
                if abs(words - entry.words) > 2:
                    continue
                distance = edit_distance(key, entry.key, limit)
                if distance <= limit:
                    candidates.append((distance, distance / length, -term_length, entry.spelling, entry))
        return [(row[-1], row[0]) for row in sorted(candidates)[:MAX_NEIGHBORS]]


class Tokenizations:
    """Find several paths through the shipped vocabulary's actual wordpieces."""

    def __init__(self, pieces, blank):
        self.ids = {piece: index for index, piece in enumerate(pieces)
                    if index != blank and piece and '<' not in piece}
        self.max_length = max(map(len, self.ids), default=1)

    def encode(self, text, limit=3):
        paths = [[] for _ in text] + [[(0.0, ())]]
        for start in range(len(text) - 1, -1, -1):
            choices = []
            for end in range(start + 1, min(len(text), start + self.max_length) + 1):
                token = self.ids.get(text[start:end])
                if token is not None:
                    cost = 1 + math.log1p(token) / 20
                    choices.extend((cost + rest, (token, *ids)) for rest, ids in paths[end])
            paths[start] = sorted(choices)[:limit]
        return [ids for _, ids in paths[0]]


@dataclass
class Emission:
    frame: int
    prediction: np.ndarray
    hidden: np.ndarray
    cell: np.ndarray


class VocabularyDecoder:
    def __init__(self, model, vocabulary, strength):
        self.model = model
        self.vocabulary = vocabulary
        self.strength = strength
        self.frames = []
        self.frame_count = 0
        self.emissions = []

    def capture_frames(self, frames):
        start = self.frame_count
        self.frame_count += len(frames)
        remaining = MAX_FRAMES - start
        if remaining > 0:
            self.frames.append(frames[:remaining].copy())
        return start

    def capture_emission(self, frame, prediction, hidden, cell):
        if frame < MAX_FRAMES:
            self.emissions.append(Emission(frame, prediction, hidden, cell))

    def tokenizations(self, rendered, spelling, original):
        model = self.model
        # Retain an acoustically likely left prefix and consider alternatives
        # in case and segmentation after it. The selected spelling is emitted
        # separately, so the model may score a different casing.
        common = 0
        for token in original:
            part = model.pieces[token]
            if not spelling.casefold().startswith((rendered[:common] + part).casefold()):
                break
            common += len(part)
        forms = dict.fromkeys((
            spelling,
            spelling.lower(),
            rendered[:common] + spelling[common:].lower(),
            rendered[:common] + spelling[common:].upper(),
        ))
        variants = {}
        for form in forms:
            offset = 0
            for length in range(len(original) + 1):
                if not form.startswith(rendered[:offset]):
                    break
                tail = form[offset:]
                for suffix in model.tokenizations.encode(tail):
                    ids = tuple(original[:length]) + suffix
                    variants[ids] = max(length, variants.get(ids, 0))
                if length < len(original):
                    offset += len(model.pieces[original[length]])
        # Score a few segmentations. Prefer compact encodings and a longer
        # shared prefix when equally compact.
        return sorted(variants, key=lambda ids: (-variants[ids], len(ids)))[:8]

    def log_probability(self, frames, tokens, predictors):
        model = self.model
        blank = model.cfg['blank_id']
        predictions = [predictors[()].prediction.reshape(-1)]
        for index, token in enumerate(tokens, 1):
            prefix = tokens[:index]
            if prefix not in predictors:
                last = predictors[tokens[:index - 1]]
                prediction, hidden, cell = model.decoder.run(None, {
                    'targets': np.array([[token]], np.int64), 'h_in': last.hidden, 'c_in': last.cell,
                })
                predictors[prefix] = Emission(last.frame, prediction, hidden, cell)
            predictions.append(predictors[prefix].prediction.reshape(-1))
        # Sum over RNN-T blank and label alignments for this same audio span.
        predictor_output = np.stack(predictions)[None, :, :]
        scores = np.full(len(predictions), -np.inf)
        scores[0] = 0
        batch_frames = max(1, MAX_JOINER_ROWS // len(predictions))
        for offset in range(0, len(frames), batch_frames):
            batch = frames[offset:offset + batch_frames]
            logits = model.joiner.run(None, {
                'encoder_output': batch[None, :, :], 'decoder_output': predictor_output,
            })[0].reshape(len(batch), len(predictions), -1)
            peak = np.max(logits, axis=-1, keepdims=True)
            normalizer = peak.squeeze(-1) + np.log(np.exp(logits - peak).sum(axis=-1))
            blanks = logits[:, :, blank] - normalizer
            labels = logits[:, np.arange(len(tokens)), tokens] - normalizer[:, :-1]
            for frame_labels, frame_blanks in zip(labels, blanks):
                if len(tokens) < model.cfg['max_symbols_per_step']:
                    for index, label in enumerate(frame_labels):
                        scores[index + 1] = np.logaddexp(scores[index + 1], scores[index] + label)
                    scores += frame_blanks
                    continue
                # The streaming decoder advances without a blank when it hits
                # its per-frame symbol limit.
                advanced = scores + frame_blanks
                emitted = scores
                for count in range(1, model.cfg['max_symbols_per_step'] + 1):
                    emitted = emitted[:-1] + frame_labels[count - 1:]
                    if count == model.cfg['max_symbols_per_step']:
                        advanced[count:] = np.logaddexp(advanced[count:], emitted)
                    else:
                        advanced[count:] = np.logaddexp(advanced[count:], emitted + frame_blanks[count:])
                scores = advanced
        return float(scores[-1])

    def choose(self, frames, tokens, offsets, text, start, end, candidates, context_end):
        prefix = BOUNDARY if start and text[start - 1] == BOUNDARY else ''
        left = bisect_left(offsets, start - len(prefix))
        right = bisect_left(offsets, end)
        if offsets[left] != start - len(prefix) or offsets[right] != end or not left < right <= len(self.emissions):
            return None
        first = self.emissions[left]
        context_right = min(bisect_left(offsets, context_end), len(self.emissions))
        last = self.emissions[context_right - 1]
        lower = max(first.frame - ALIGNMENT_MARGIN, self.emissions[left - 1].frame if left else 0)
        next_frame = self.emissions[context_right].frame + 1 if context_right < len(self.emissions) else len(frames)
        upper = min(last.frame + ALIGNMENT_MARGIN + 1, next_frame)
        window = frames[lower:upper]
        original = tuple(tokens[left:right])
        suffix = tuple(tokens[right:context_right])
        baseline_tokens = original + suffix
        observed = text[start:end].replace(BOUNDARY, ' ')
        previous = text[:start].rstrip(BOUNDARY)
        name_context = observed[0].isupper() and bool(previous) and previous[-1] not in '.?!'

        predictors = {baseline_tokens[:index]: self.emissions[left + index]
                      for index in range(min(len(baseline_tokens) + 1, len(self.emissions) - left))}
        baseline = self.log_probability(window, baseline_tokens, predictors)
        best = None
        for entry, distance in candidates:
            allowance = NAME_LOG_PRIOR if name_context else WORD_LOG_PRIOR
            if distance <= 1:
                allowance = max(allowance, ONE_EDIT_LOG_PRIOR)
            if self.strength is not None:
                allowance = min(allowance, self.strength)
            spelling = prefix + BOUNDARY.join(entry.spelling.split())
            for ids in self.tokenizations(text[offsets[left]:end], spelling, original):
                score = self.log_probability(window, ids + suffix, predictors)
                required_boost = max(0.0, baseline - score)
                if required_boost <= allowance and (best is None or score > best[0]):
                    if len(candidates) == 1:
                        return entry.spelling
                    best = (score, entry.spelling)
        return best[1] if best else None

    def find_candidates(self, rendered, words, index):
        start = words[index].start()
        exact = None
        alternatives = []
        contiguous = True
        for count, last in enumerate(words[index:index + self.vocabulary.max_words], 1):
            if count > 1:
                separator = rendered[words[index + count - 2].end():last.start()]
                contiguous = contiguous and separator.isspace()
            end = last.end()
            span = rendered[start:end]
            punctuation = rendered[end:end + 1]
            entry = None
            if punctuation and punctuation in '.!?':
                entry = self.vocabulary.entries.get(spelling_key(span + punctuation))
                if entry:
                    exact = (end + 1, entry.spelling)
                    continue
            entry = self.vocabulary.entries.get(spelling_key(span))
            if entry:
                exact = (end, entry.spelling)
            elif contiguous:
                candidates = self.vocabulary.candidates(compact(span), count)
                if candidates:
                    alternatives.append((end, candidates))
        return exact, alternatives

    def resolve(self, tokens):
        pieces = [self.model.pieces[token] for token in tokens]
        text = ''.join(pieces)
        offsets = [0]
        for piece in pieces:
            offsets.append(offsets[-1] + len(piece))
        frames = np.concatenate(self.frames) if self.frames else ()
        rendered = text.replace(BOUNDARY, ' ')
        # Language tags are model metadata, even if their contents look like a word.
        lexical_text = re.sub(r'<[^<>]*>', lambda match: ' ' * len(match[0]), rendered)
        words = list(WORD.finditer(lexical_text))
        proposals = [self.find_candidates(rendered, words, index) for index in range(len(words))]
        word_ends = [word.end() for word in words]
        exact_starts = [word.start() for word, (exact, _) in zip(words, proposals) if exact is not None]
        result = []
        offset = 0
        for word, (exact, alternatives) in zip(words, proposals):
            start = word.start()
            if start < offset:
                continue
            if exact is not None:
                end, spelling = exact
            else:
                next_exact = bisect_left(exact_starts, start)
                spelling = None
                for end, candidates in alternatives:
                    if next_exact < len(exact_starts) and end > exact_starts[next_exact]:
                        break
                    next_word = bisect_left(word_ends, end) + 1
                    context_end = word_ends[min(next_word + 1, len(word_ends) - 1)]
                    spelling = self.choose(frames, tokens, offsets, text, start, end, candidates, context_end)
                    if spelling is not None:
                        break
                if spelling is None:
                    continue
                if spelling[-1] in '.!?' and rendered[end:end + 1] == spelling[-1]:
                    end += 1
            result.extend((text[offset:start], spelling))
            offset = end
        result.append(text[offset:])
        return ''.join(result)
