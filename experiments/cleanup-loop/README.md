# Local transcript cleanup loop

This is an offline training and comparison workflow, independent of the running
Memo app. It uses base transcripts, not audio. It never changes production model
selection, uploads dictations, or publishes adapters.

## What the first cycle proves

The default is a **20-step training smoke test**, not a production fine-tune.
It fetches pinned LFM2.5-1.2B-Instruct weights and the public CoEdIT dataset,
converts the model to 8-bit MLX, trains a small QLoRA adapter, and compares base
versus adapter outputs on 40 development dictations and 24 public-derived
validation pairs. The 10 reserved real examples are not sent to inference.

CoEdIT is supplementary task data, **not LFM's original pretraining corpus**.
The source includes broad rewriting tasks that would teach unwanted behavior.
We filter to GEC rows and use only their clean targets to construct punctuation
and casing examples. Original source-to-rewrite pairs are not used. This first
dataset does not teach paragraphs, stutter removal, or backtracking; those need
separately reviewed speech-cleanup pairs. All generated labels are provisional.

Pinned sources:

- `LiquidAI/LFM2.5-1.2B-Instruct@0f604ada3f766f9f257460c4c9f0b5d6f69d431b`
- The expanded model registry pins all candidates by commit; see the research
  shortlist below. Registration alone does not establish runtime or training compatibility.
- `grammarly/coedit@e9a255c33ef910bc33a9d2b522653fa87521583e`

Source notices are downloaded. Model and dataset redistribution terms need to
be checked for any eventual release. Downloading and testing a model does not
make it a production candidate.

## Run

Requires macOS on Apple silicon, the `hf` CLI, and an MLX-LM training environment.
The default Python path reuses this checkout's existing local training environment.
For another environment, supply `--python /absolute/path/to/python`.

```sh
python3 experiments/cleanup-loop/loop.py cycle
```

Screen a candidate without training an adapter:

```sh
python3 experiments/cleanup-loop/loop.py screen --model lfm-350m
```

The config has the same schema as `config.json`; change `model` to any registered
key below. Screens use the same prompt, 8-bit conversion, deterministic decoding,
development snapshot and provisional validation pairs as the first LFM run.
They do not establish which model will fine-tune best.

To fetch another registered model without training:

```sh
python3 experiments/cleanup-loop/loop.py fetch --model qwen-0.8b
```

Copy `config.json` to an ignored local file, change one variable, and rerun:

```sh
python3 experiments/cleanup-loop/loop.py cycle --config .build/cleanup-loop/next-config.json
```

Each cycle is bounded by its iteration count and generates a new run directory.
Downloads and verified model conversions are reused. Dataset files are versioned
by content and may not be edited in place. Change the preparation recipe or row
counts to generate a new dataset version. Runs record weights, source revisions,
data hashes, the instruction, runner hash, package versions, and settings.

For a richer local training dataset, create a JSONL file with explicit splits:

```json
{"id":"correction-001","family_id":"lunch-time-correction","split":"train","input":"let us meet at two actually three","expected_output":"Let us meet at three.","review_status":"agent_draft_pending_human_review","source_kind":"synthetic_authored"}
```

Include validation examples from different families, then run:

```sh
python3 experiments/cleanup-loop/loop.py cycle --pairs .build/cleanup-loop/curated-pairs.jsonl
```

The loop rejects shared families across splits, normalized duplicate inputs, and
near duplicates with the protected real benchmark. Editing this input file creates
a new dataset version on the next run. Review status is recorded; it does not
automatically turn provisional labels into approved labels.

Compare completed runs after filling their local review labels:

```sh
python3 experiments/cleanup-loop/loop.py compare --runs /absolute/path/to/run-one /absolute/path/to/run-two
```

Comparison requires identical real evaluation snapshots. Validation scores from
different datasets are not directly comparable. No winner is declared automatically.

To review base outputs across model families with randomized identities per case:

```sh
python3 experiments/cleanup-loop/loop.py review-models --runs /absolute/path/to/run-one /absolute/path/to/run-two
```

This creates a separate private comparison folder containing a combined
`review.html`, a separately saved identity key, and review-label placeholders.
The shared review is for the real development cases only. Its labels are separate
from each run's base-versus-adapter labels; the comparison does not import or
score them automatically.

## Edit → run → review → repeat

1. Define the output contract and review labels on development data.
2. Establish each base model's output before adapter training.
3. Change one axis: prompt, dataset, adapter settings, model, or precision.
4. Run a bounded cycle; compare the same development inputs.
5. Review `review.html` with randomized A/B labels. Record judgments in
   `review-labels.jsonl`; `review-key.json` reveals model identity afterward.
6. Record critical errors separately from readability. Use token checks as
   diagnostics, never as a substitute for meaning review.
7. Continue only when a change fixes an identified failure. If a configuration
   regresses, retain its artifacts and return to the prior candidate.
8. Freeze a finalist, then run a separate reserved evaluation. Do not tune on
   that evaluation; examining its failures spends it for future model selection.
9. Validate shipping precision, memory with Conomo resident, installed-worker
   behavior, and clean-machine startup before any application integration.

The initial 50 real examples must remain outside training. Exact and near
duplicates with the new public-derived training data are checked. Prior overlap
with historical Memo training corpora remains unknown and needs an audit before
treating these examples as a clean final test set. Review semantic families too;
string similarity cannot establish independence.

## First completed local experiment

Run `20261006T214055Z-bd973038` completed on October 6, 2026 on an M5 Pro Mac
with 24 GB of memory: 128 training pairs, 24 validation pairs, 20 training steps,
and 40 real development dictations. Both variants produced all 64 outputs; none
of the 10 reserved real cases reached inference.

| Observation | Base | Adapter |
| --- | ---: | ---: |
| Warm median generation time, mixed evaluation inputs | 338 ms | 394 ms |
| Warm p95 generation time | 919 ms | 1,129 ms |
| Exact provisional validation targets | 1 / 24 | 1 / 24 |

Training validation loss fell from 0.859 to 0.604. Spot checks nevertheless found
unwanted rewriting in both variants, and added commentary and omitted details
in some adapter outputs. This is evidence that the workflow runs, not evidence
that this adapter improves faithful cleanup. No model has been promoted.

The final adapter is 5,575,703 bytes; the converted model and tokenizer assets
total 1,248,410,402 bytes. A small adapter still requires the base model. These
are local experiment assets, not application package size measurements.

The next useful iteration is to add reviewed dictation-specific pairs for
corrections, uncertainty, lists and long inputs, then compare the same real
development cases. Increasing training steps alone does not address label quality.

## Model diligence, October 6, 2026

The first LFM experiment was a workflow check. It did not select a model.
Hugging Face's repository inspection connector, official model cards, and Hub
metadata were checked for other candidates. Current metadata and cards are saved
locally under `.build/cleanup-loop/research/2026-10-06/`.

| Registry key | Official checkpoint | Role in the screen |
| --- | --- | --- |
| `lfm-1.2b` | [LFM2.5-1.2B-Instruct](https://huggingface.co/LiquidAI/LFM2.5-1.2B-Instruct) | Existing experiment reference; 1.170B parameters |
| `lfm-350m` | [LFM2.5-350M](https://huggingface.co/LiquidAI/LFM2.5-350M) | Smaller current Liquid model; 354M parameters |
| `lfm-230m` | [LFM2.5-230M](https://huggingface.co/LiquidAI/LFM2.5-230M) | Minimum footprint candidate; 230M parameters |
| `qwen-0.8b` | [Qwen3.5-0.8B](https://huggingface.co/Qwen/Qwen3.5-0.8B) | Different architecture and instruction tuning; 873M total published parameters |
| `qwen-2b` | [Qwen3.5-2B](https://huggingface.co/Qwen/Qwen3.5-2B) | Larger quality comparator; 2.274B total published parameters |
| `smollm-360m` | [SmolLM2-360M-Instruct](https://huggingface.co/HuggingFaceTB/SmolLM2-360M-Instruct) | English-focused small Transformer; 362M parameters |
| `granite-350m` | [Granite-4.0-350M](https://huggingface.co/ibm-granite/granite-4.0-350m) | IBM's compact text model; 352M parameters; distinct from Conomo's speech model |

The small Liquid models reuse the LFM architecture already supported by the
worker. Their cards describe structured-output tasks and Apple Silicon support;
that makes them relevant candidates, not proven transcript cleaners. Liquid uses
the custom LFM license. Qwen, SmolLM2 and these Granite checkpoints publish Apache
2.0 licenses. Qwen3.5's original checkpoints contain multimodal components; only
text inference is needed here, and converted asset sizes must be measured.

Other options considered:

- [Gemma 4 E2B](https://huggingface.co/google/gemma-4-E2B-it): its card lists 2.3B
  effective parameters but 5.1B including embeddings. Defer this larger footprint
  until small candidates demonstrate a quality ceiling. Do not estimate download
  size from the E2B name.
- [Gemma 3 270M](https://huggingface.co/google/gemma-3-270m-it): a relevant tiny
  candidate, but this session's unauthenticated repository lookup returned 401. Its
  gated access and separate Gemma terms need resolving before a reproducible test.
- [CoEdIT-large](https://huggingface.co/grammarly/coedit-large): a specialized T5
  editor, but its weights publish CC-BY-NC-4.0 and its broad editing behavior
  differs from faithful dictation cleanup. Excluded from the shipping shortlist.
  The CoEdIT dataset used in the smoke test separately publishes Apache 2.0.
- [FLAN-T5-small](https://huggingface.co/google/flan-t5-small) (77M) and
  [FLAN-T5-base](https://huggingface.co/google/flan-t5-base) (248M): Apache 2.0
  encoder-decoder candidates for a specialized text-editing experiment. These
  require a separate inference/training backend from this MLX-LM chat-model loop.
  [CTranslate2 documents T5 support](https://opennmt.net/CTranslate2/guides/transformers.html),
  providing a possible CPU deployment route; performance and faithful cleanup
  have not been tested here. A model's older release date is not itself a reason
  to exclude it from a narrow editing task.
- [Granite 4.2 3B](https://huggingface.co/ibm-granite/granite-4.2-3b), SmolLM3 3B,
  and larger Phi/Llama models: possible quality comparators after the first screen,
  with greater storage and runtime requirements.
- [Nanowhale 100M](https://huggingface.co/HuggingFaceTB/nanowhale-100m): research
  implementation with custom runtime code; lower priority than compact candidates
  supported by the existing worker.
- Apple Foundation Models and the installed punctuation/casing model: separate
  local platform baselines. They are not covered by this Hugging Face screen.

Model-card leaderboards do not measure preservation of spoken corrections,
negations, requests or uncertainty. The selection sequence is:

1. Screen stock models on the frozen development inputs; retain failures too.
2. Review semantic errors separately from readability and token diagnostics.
3. Give promising candidates a bounded prompt/sampling sweep using their native
   templates and documented settings. The initial shared greedy decoding is a
   controlled configuration, not every model's recommended operating point.
4. Fine-tune finalists with the same reviewed data and comparable training-token
   budgets. Equal step counts alone are not equivalent across tokenizers.
5. Compare free-text formatting with constrained edits for the finalists.
6. Test shipping precision and full-app memory with Conomo resident, then evaluate
   fresh independent data before selecting or shipping a model.

### Completed seven-model screen

All seven base models were run on the same 40 real development dictations and
24 provisional formatting validation inputs. The 10 reserved real dictations
remained outside inference. Measurements below use 8-bit MLX, the same instruction
and greedy decoding, and an M5 Pro Mac with 24 GB memory. Latency covers standalone
generation on the mixed evaluation inputs, not full-app dictation insertion.
Asset sizes are decimal MB and include converted weights and tokenizer files.

| Model | Converted assets | Warm median | Warm p95 | Outputs reaching generation limit |
| --- | ---: | ---: | ---: | ---: |
| LFM2.5-230M | 249 MB | 88 ms | 265 ms | 0 / 64 |
| LFM2.5-350M | 382 MB | 150 ms | 455 ms | 0 / 64 |
| Granite-4.0-350M | 382 MB | 166 ms | 322 ms | 0 / 64 |
| SmolLM2-360M-Instruct | 388 MB | 178 ms | 804 ms | 3 / 64 |
| Qwen3.5-0.8B | 820 MB | 374 ms | 681 ms | 0 / 64 |
| LFM2.5-1.2B-Instruct | 1,248 MB | 338 ms | 919 ms | 0 / 64 |
| Qwen3.5-2B | 2,020 MB | 642 ms | 1,249 ms | 0 / 64 |

Two initial SmolLM/Granite runs overlapped on the GPU and were excluded from
reported timing. Their serial repeats are used above. Future cycles serialize
conversion, inference and training with a local GPU lock. Downloads now select
native checkpoint/tokenizer files instead of duplicate ONNX/GGUF exports.

No semantic pass rate or winner has been established. Unblinded agent spot checks
found task-contract failures in every configuration; the details remain private
under the research folder. In the inspected examples, Qwen2B preserved an ambiguous
word and the two topics of a long dictation better than some smaller alternatives,
but still retained explicit spoken corrections rather than resolving them.
Small LFM models sometimes added explanations or returned little formatting.
Granite dropped the corrected time and place in one meeting example. SmolLM's
three incomplete outputs were all real development cases. These are observations
about this prompt/decoding configuration, not proof that a model family cannot
be adapted successfully.

The combined randomized review is saved under
`.build/cleanup-loop/comparisons/20261006T220535Z-1adf0572/`. It covers only real
development inputs and uses the stock base output from the original LFM1.2B run;
the earlier 20-step adapter is not used as a model-family reference.

Provisional next priorities are LFM350M for footprint, Qwen0.8B for a different
small architecture, and Qwen2B as a larger fidelity comparator. Give these a
bounded native prompt/sampling sweep, then fine-tune using the same reviewed
dictation-specific data. Test the separate FLAN-T5/edit-prediction route before
making a final architecture decision. The installed production formatter and
punctuation/casing path still need controlled comparison in the full app.

## Artifacts and interpretation

Everything downloaded or generated is under `.build/cleanup-loop/`, which is
ignored by Git. Run artifacts can contain private transcripts and use private
file permissions.

- `run.json`, `environment.json`, `training.json`: reproducibility information.
- `training.log`, `adapter/`: training observations and adapter checkpoints.
- `base.jsonl`, `adapter.jsonl`: raw generated outputs; no fallback substitution.
- `summary.json`: completion, lexical diagnostics, timing, and memory observations.
- `review.html`, `review-labels.jsonl`: local A/B review.

Exact target matches apply only to provisional public-derived validation pairs.
Changed words can be valid contractions, fillers, or spoken corrections. Matching
words can still have incorrect punctuation and meaning. Neither statistic is a
semantic pass rate. The summary intentionally does not declare a winner.

Warm latency and process/MLX memory are measured in standalone processes, not
with the full Memo app. These measurements cannot establish minimum-spec Mac
performance or end-to-end insertion latency.

Run the workflow's data isolation checks without models:

```sh
python3 -m unittest discover -s experiments/cleanup-loop -p 'test_*.py'
```
