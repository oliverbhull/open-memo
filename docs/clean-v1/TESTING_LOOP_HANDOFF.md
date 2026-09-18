# Reliable speech cleanup: testing loop and agent handoff

> Historical experiment record. This is not the current runtime or release contract.
> See [current development guide](../development.md). Nemotron, placeholder restoration,
> semantic gates, and annotation-only cleanup described here are not active.


Current user-authorized development test: [LFM dictation cleanup](LFM_DEV.md). On 2026-09-11 Oliver requested returning to the previous LFM model for simple manual testing with `npm run dev`. The local fused step-1024 LFM model and its original cleanup prompt are restored. Oliver subsequently explicitly requested removing the semantic safety gate; the active worker now delivers completed LFM edits without semantic rejection. Development mode retains raw Granite on fallback and does not invoke PnC. Earlier Nemotron experiments and the historical evaluation gates below do not block this explicitly requested local test.

Status: design only, revised 2026-09-05 for Astra arbitration with Sol/Terra workers. This document does not approve a model, start agents, enable live cleanup, or authorize publication. Implement and evaluate locally when execution is requested; preserve unrelated checkout changes. No dataset uploads, purchased compute, pushes, release or installed-app replacement are included. Requested hosted-agent work consumes the account's existing usage; it does not authorize purchases or a cloud cleanup backend.

**Operating design: Terra builds and prepares data; Sol independently evaluates; Astra decides.** Give workers small assignments with verifiable outputs. Bring Astra evidence at decision points and on exceptions, rather than having Astra repeat their work. Oliver remains the authority on intended meaning and acceptable editing.

## Outcome

Turn messy dictated text into readable writing while retaining the speaker's meaning, tone, questions, uncertainty and distinct details. Remove verbal fillers, accidental repetition and clearly abandoned starts; repair obvious grammar and punctuation. Changing words is allowed. Summarizing, answering the transcript, inventing facts or guessing unclear speech is not.

Use one local LLM call with a short instruction. Keep timeout/recovery and narrowly justified checks outside it. Do not replace the task with punctuation-only formatting or use an unchanged-word requirement. Do not compensate for recurring model failures with phrase-specific exceptions or a chain of rewriting models.

The loop must answer separately:

1. Did the model preserve meaning?
2. Did it produce writing the user would actually keep?
3. Did the application deliver the selected result reliably?

Passing one does not imply the others. “Perfect” is not the completion criterion; the measurable gates below are.

## Starting evidence: read before working

Repository: `/Users/oliverhull/dev/open-memo`.

- `experiments/clean-v4/core.py`: current light-copyediting instruction and input framing.
- `experiments/clean-v4/run.py`: local review-only inference runner.
- `experiments/clean-v4/README.md`: prompt experiments and limitations. The last section is the latest comparison; earlier observations are historical.
- `.build/clean-v4/copyedit-comparison.json`: paired results on 12 reused development examples. These are spent, not a holdout.
- `docs/clean-v1/RELIABLE_FORMATTING.md`: current development integration and previous training results.
- `electron/main/services/CleanupWorkerClient.ts`: bounded worker protocol and recovery.
- `electron/main/services/CleanupService.ts` and `electron/main/index.ts`: current live route; verify it before changing anything.

Current experiment: local LFM2.5-1.2B-Instruct-MLX-8bit, no adapter, greedy generation, one request, transcript framed as a JSON string. The latest prompt fixes two observed errors but still turns a question into a statement and leaves awkward wording. Its diagnostic `accepted` status means only basic checks passed. It is not a semantic verdict. The live route remains v3.1 punctuation/capitalization, not this LLM experiment.

Previous LoRA training was formatting-oriented and failed its own fresh holdout. Do not reuse it as evidence of speech-cleanup quality. Prior datasets/results may seed development regressions only after inspection for relevance and provenance.

## Roles and ownership

Use one Astra coordinator and at most three active subagents. These are design assignments, not a request to start them now. Model choices are explicit so workers do not inherit Astra accidentally.

| Role | Model and initial effort | Owns | Cannot decide or change |
| --- | --- | --- | --- |
| Arbiter/coordinator | `gpt-6-astra`, high at decision points | Contract, work queue, acceptance of patches, escalations, candidate freeze, qualification and integration decision | Cannot waive gates, manufacture human approval or use final evidence to tune the same candidate |
| Corpus curator | `gpt-5.6-terra`, medium | Authorized source inventory, provenance, deduplication, local annotation/review tooling, split manifests and final-set custody | Cannot tune candidates, promote reference drafts to human-approved, or expose final cases to builders |
| Candidate engineer | `gpt-5.6-terra`, medium | Runner, protocol tests, development candidates, local inference/training, candidate manifests; later an integration patch | Cannot read final cases, author their independent evaluation, alter gates or activate a candidate |
| Independent evaluator | `gpt-5.6-sol`, medium | Blind review tooling and permitted reviews, failure ledger, independently recomputed metrics, evidence package | Cannot edit candidate output, tune the candidate, overwrite reviewer labels or grant final qualification |

Sol is the first escalation for a bounded engineering task Terra cannot resolve. Stop the Terra assignment and use its slot for a fresh Sol engineering context; do not convert the evaluator into the author of work it must independently review. Astra handles questions about meaning, conflicting evidence, contract changes and whether to advance. This allocation is an operating default, not a measured claim that one worker model is best for every subtask.

Current local tools advertise these model IDs. Verify model/effort availability when execution starts and record the actual model used. Do not silently substitute Astra for an unavailable worker. Official [subagent guidance](https://learn.chatgpt.com/docs/agent-configuration/subagents) documents model inheritance, explicit overrides and the extra token usage from delegation. Smaller worker models alone do not guarantee a cheaper run.

### Small contexts and explicit file ownership

Start workers with a fresh context containing the task packet, this contract and only their required source files. In the current collaboration tool, use `fork_turns="none"` with explicit `model` and `reasoning_effort`; check the available tool schema on another client. Do not copy the entire parent conversation, historical experiments or another reviewer's verdicts into each assignment. Workers may not create further agents.

At execution start, record the dirty-checkout inventory. Prepare an isolated execution worktree with an explicit snapshot of the relevant current uncommitted code; a bare checkout of HEAD may omit the existing cleanup work. Preserve the source checkout. Within the execution workspace, use one writer per path:

| Owner | Proposed writable area |
| --- | --- |
| Astra | Contract, task packets, decision ledger and accepted integration changes |
| Curator | `experiments/clean-loop/data/`, `.build/clean-loop/corpus/` and local review packages |
| Engineer | `experiments/clean-loop/runner/`, `experiments/clean-loop/candidates/`, their tests and `.build/clean-loop/runs/` |
| Evaluator | `experiments/clean-loop/evaluation/`, `.build/clean-loop/reviews/` and `.build/clean-loop/reports/` |

Astra fixes shared schemas and CLI boundaries before parallel implementation. Package metadata, shared entrypoints and existing app files need a named single writer in a separate packet. Workers return a diff and evidence; they do not commit, merge or activate live selection. Astra reviews and accepts the patch. A worker may prepare an app-integration patch only after the offline qualification gate.

Separate contexts and directories are workflow boundaries, not filesystem isolation. With shared tool access, a directory named `hidden` is not a security boundary. Prefer keeping the final material with Oliver until freeze, or outside the builder's enforced read scope when the runtime supports it. Otherwise document the procedural separation honestly. Curator never sends final text, references, error examples or row-level final results to a builder. Astra receives only counts/hashes for the final set before freeze. Stop candidate-editing agents before the final run. Any final exposure that informs a candidate change spends the set, including exposure through parent summaries.

### Data boundary

Keep cleanup inference/training and corpus storage local. Hosted Astra/Sol/Terra review is a separate data use: local files printed into an agent's tool output become agent context. By default, send code, hashes, counts and synthetic fixtures; keep private dictation text/audio out of messages, tool output and tracked reports. Honor any existing explicit authorization for hosted review of particular data, and record its scope before including that data in an agent packet. Without it, use local review pages and human labels for real examples; agents can still implement the runner, analyze metadata and review synthetic cases. Do not call this fully offline agent reasoning.

### Work order and Astra checkpoints

| Stage | Work that can proceed | Evidence Astra needs to advance |
| --- | --- | --- |
| 0. Establish the contract | Curator inventories sources; engineer maps the current runtime; Sol checks the rubric for ambiguity | Current-code snapshot, available-data counts, fixed schemas, privacy scope and attempt ledger |
| 1. Build the loop | Curator prepares calibration/splits; engineer builds runner on synthetic fixtures; Sol builds review/reporting against the same schemas | Runner/protocol checks, reproducible synthetic smoke run, calibration review status and leakage report |
| 2. Develop candidates | Engineer runs one declared candidate at a time; Sol evaluates its frozen outputs; curator handles pending human review | Paired development metrics, all material errors, regressions and the one-factor proposal for the next attempt |
| 3. Escalate or stop | Only if warranted, the bounded training round and then one other local model | Data eligibility, attempt/resource ledger and a development pass or evidence-backed rejection |
| 4. Freeze and qualify offline | Engineer stops changing candidate code; evaluator verifies hashes, runs the final suite once and collects reviews | Exact frozen artifact, all 200 human reviews, adjudications and every offline gate |
| 5. Qualify development integration | Engineer prepares the bounded integration patch; Sol independently reviews delivery checks; Oliver completes prospective dictations | Applicable tests, actual destination evidence, 50 prospective results and rollback selection |

Stages are dependency barriers, not three perpetually busy agents. Do not start a candidate run before its data/schema is validated, or final evaluation while human calibration remains unresolved. Keep only useful independent work active. Worker completion alone never advances a stage; Astra records the decision and evidence references.

### Task packet and return contract

Store task packets and results under `.build/clean-loop/tasks/<task-id>/`. Packets must be self-contained enough to execute without reconstructing the conversation. The following is a proposed schema, not an implemented command:

```yaml
task_id: runner-001
role: candidate_engineer
model: gpt-5.6-terra
reasoning_effort: medium
objective: Implement bounded inference and immutable output recording.
contract_path: docs/clean-v1/TESTING_LOOP_HANDOFF.md
contract_sha256: <frozen-contract-hash>
source_snapshot: <base-commit-plus-relevant-diff-hash>
inputs: [<schema-path-and-hash>, <synthetic-fixture-path-and-hash>]
read_scope: [<explicit-approved-code-and-data-paths>]
write_scope: [experiments/clean-loop/runner/, <assigned-test-path>]
forbidden: [final-data, gate-edits, live-selection, uploads, purchases, commits, pushes, child-agents]
depends_on: [schema-001]
acceptance: [<observable-check-and-required-result>]
deliverables: [<patch-path>, <checks-path>, <result-path>]
budget:
  implementation_passes: 1
  corrective_passes: 1
  candidate_runs: 0
  summary_words_max: 400
stop_on: [out-of-scope-change, missing-required-input, repeated-failure, evidence-conflict]
```

Workers return `status: complete | incomplete | failed`, changed paths, input/candidate hashes, exact commands and exit codes, output paths, counts, remaining uncertainties and at most one requested decision. A zero exit code is not a semantic judgment. Missing evidence means incomplete, even if the worker says complete. Keep private examples in their approved local review package rather than pasting them into summaries.

Astra validates artifact hashes and the requested checks, examines the relevant diff and verifies reported metrics from the saved evidence. It returns `accept | revise | reject | needs-human`, with the task/candidate ID, supporting paths, reason and next allowed action. Keep worker completion, candidate qualification and user approval in separate fields.

### Cost and escalation rules

- Run deterministic inventory, validation, counting, deduplication and report generation in scripts. Do not spend model calls recounting rows or narrating logs.
- Assign one coherent artifact or a review batch of at most 25 cases per packet. Reuse a worker only for the same role and data scope; give it a fresh context if authorship or holdout exposure changes.
- One implementation pass plus one corrective pass per packet. A retry that changes the prompt/model/checking behavior also consumes the candidate budget in Step 5. Failed or discarded experiments stay in the ledger.
- Send routine evidence as one batch. Escalate immediately for suspected material meaning change, final-set leakage, lost/misdelivered text, disputed labels, need to change the contract or exhausted retry budget. Infrastructure blockers go to Astra with a minimal reproduction, not a speculative rewrite.
- Astra arbitrates all flagged semantic disagreements and audits a reproducible 10% sample (rounded up) of apparently passing development reviews, selected after outputs are fixed. Inspect source/output text only within the recorded data authorization; otherwise route those cases to local human review. If the audit finds a missed material error, re-review the affected batch and record the evaluator failure. A sampling audit never substitutes for the complete final human review.
- Start workers at medium effort. Raise effort or move a bounded Terra task to Sol only for a documented blocker. Astra does not redo routine implementation or continuously reread all transcripts.
- Serialize local inference/training and latency benchmarking. Do not run competing model jobs on the same Mac; representative ASR load is a deliberate benchmark condition.
- Record available input/output/cache/reasoning usage, wall time, retries and actual model per packet. Use `unknown` for unavailable usage/cost fields. Report total worker plus Astra usage; do not infer dollars from API prices for a ChatGPT subscription. A token/cost cap, if supplied later, must stop new assignments before it is exceeded and produce a resumable handoff.

The experiment attempt cap in Step 5 remains the outer limit. Cheaper agents do not get an unlimited search budget. Prefer an evidence-backed rejection over repeated retries that merely move cost into coordination.

## Step 1: establish the desired edit level

Assemble 50 distinct real dictations with raw ASR text, using existing authorized local material first. Preserve audio when available. Deduplicate against prior experiments. Do not silently treat generated prose as real speech.

Curator arranges a draft clean target and the facts/intent that must survive for each, through authorized agent review or local tooling/human annotation within the data boundary above. Have Oliver review a compact first batch of 15 representative before/after pairs: too little editing, right amount, or too much editing, with corrections. Astra reconciles the contract once. Seek review of the remaining examples in manageable batches, not a 50-question interrogation.

Independent work continues while review is pending: build the runner, manifests, tests and provisional corpus. If human review is unavailable, label outputs agent-reviewed only when agent review actually occurred, otherwise unreviewed. Stop at a provisional decision; do not claim offline qualification, user preference validation or live readiness. If local real data is insufficient, deliver the exact missing count and a short recording collection script. Do not fill the gap with synthetic material and call it complete.

A target is an example, not the only acceptable wording. Record obligatory meaning separately from prose. When the audio and raw ASR disagree, label an ASR error. Evaluate cleanup against the supplied transcript; it must not invent an audio correction it cannot infer. Evaluate the complete speech-to-text experience separately using audio.

Example annotation:

```json
{
  "id": "dictation-0042",
  "source_kind": "real_asr",
  "speaker_id": "local-speaker-a",
  "session_id": "local-session-7",
  "group_id": "same-utterance-and-all-variants",
  "audio_path": null,
  "raw": "um I think we should we should probably wait until Friday because Sarah has not approved the quote yet",
  "reference": "I think we should probably wait until Friday because Sarah hasn't approved the quote yet.",
  "must_preserve": ["tentative recommendation to wait until Friday", "Sarah has not yet approved the quote"],
  "speech_act": "tentative_recommendation",
  "allowed_edits": ["remove um", "remove duplicate we should", "contract has not"],
  "tags": ["repetition", "uncertainty", "negation", "name", "date"],
  "needs_cleanup": true,
  "review_status": "human_approved",
  "split": "development"
}
```

## Step 2: build and lock evaluation data

Use the 50 calibration examples within a 150-case development suite: 125 needing cleanup and 25 already acceptable. Add a separate 200-case final suite, preferably real ASR from later sessions, with 150 cases needing cleanup and 50 already acceptable cases. Keep synthetic adversarial cases as a separately reported stress suite of at least 50; never let them replace real-world coverage. The fixed development mix makes the pre-final selection gates reproducible.

Split by utterance family and recording session, not rows. Paraphrases, synthetic variants, overlapping clips and repeated phrases from the same source stay in one split. Training rows and augmented relatives cannot appear in either evaluation split. Check exact and near duplicates; log manual decisions. Keep speakers separate where data permits. A single-speaker corpus supports a personal candidate only; broader claims require held-out speakers and coverage of accents, microphones and environments.

Across the real suites, tag and cover fillers/repetition, false starts, corrections, questions, negation, uncertainty, attribution, names, amounts/dates/units, quoted text, URLs/code, short commands, long multi-sentence passages, paragraphs and already-clean text. Require at least 15 examples per meaning-critical tag (tags may overlap). Include ambiguous transcripts where restraint is correct. Report actual counts before any candidate run.

Declare the meaning-critical tag list in the split manifest before annotation: corrections, questions, negation, uncertainty, attribution, names, amounts/dates/units, and quoted text/URLs/code. Report both combined and per-split counts so missing final coverage is visible. If the available data cannot meet the required coverage, report the exact deficit and continue tooling work without claiming a complete suite.

For stress cases, include literal requests/instructions as dictated text, apparent system prompts, quoted commands, contradictory corrections and long input at/over the runtime limit. Input text must remain data.

Curator creates split manifests, hashes and provenance before candidate tuning. The final set stays hidden from candidate builders. Exposing it to any prompt/training decision spends it: move it to regression coverage and collect a new final set. Do not repeatedly run candidates on the same “hidden” set.

## Step 3: implement the repeatable runner

Suggested home: `experiments/clean-loop/`; private data/results: `.build/clean-loop/`. Keep private text/audio out of tracked reports.

Keep this a small local CLI with JSON/JSONL artifacts. The design does not call for a new agent framework, service, dashboard, message broker or cloud judge. Store manifests, task state and decisions in versioned local files; make the existing collaboration tools the orchestration layer.

Implement CLI stages `validate-data`, `run`, `review`, `report`, and `freeze`. Commands must fail nonzero for invalid manifests, missing required reviews or failed gates. A pending human review should produce an explicit incomplete status, never a green pass. Pin local dependencies and run with network disabled for inference. Never download a model implicitly.

A run records immutable input IDs/hashes, model and adapter hashes, tokenizer, exact prompt and framing, decoding settings, maximum tokens, dependency/runtime versions, machine, elapsed time and peak memory. For every row retain raw model output, selected output, fallback reason and separate reviewer verdicts. Detect generation truncation/EOS: a token-limit cutoff is not a valid clean result. Resume by candidate hash plus input hash; do not overwrite earlier output.

The candidate hash covers prompt/framing, model/tokenizer/adapter artifacts, decoding, worker/selection code, bounds and supervisor configuration. Store hosted worker/reviewer identities and their usage separately from this local cleanup candidate. Missing model output stays a recorded mechanics failure or fallback; it must not disappear from the denominator. Track repeated latency measurements separately from unique quality examples.

Evaluate three views: raw transcript baseline, raw LLM candidate, and final selected result after checks/fallback. The raw baseline exposes a system that “passes safety” by doing nothing. The candidate view exposes errors hidden by fallback. The selected view measures what users receive. Existing PnC can be shown as a secondary formatting baseline, never as the cleanup target.

Use exact-match scores only as diagnostics. Do not require exact target prose. Normalize no semantic differences away. Save model output before stripping wrappers so that formatting defects remain visible.

## Step 4: review with a small, explicit rubric

Reviewers see the source, meaning annotations and anonymized candidate in the authorized review surface; randomize candidate ordering. Hide model/prompt identity, guard acceptance and other reviewers' labels until the initial review is saved. They judge meaning before fluency. A model can draft judgments, but cannot be the sole final judge of its own outputs. Human review is required for the entire 200-case final set, with a second human reviewer for every suspected meaning error and disagreement. Preserve original labels and adjudication reasons.

Before full review batches, check Sol's rubric application on a small synthetic calibration pack containing known meaning changes and acceptable paraphrases. This calibrates the reviewer, not the cleanup candidate. Review every development case for a candidate being considered for freeze; sampled triage alone cannot establish its development pass. Human reviewers give their first verdict without seeing Sol's recommendation.

Astra decides whether the evidence supports a gate, and resolves technical/rubric disputes with a written reason. Astra cannot outvote Oliver on his intended meaning or convert agent consensus into human approval. An unresolved human disagreement remains unresolved and prevents qualification. If adjudication requires changing the contract after final outputs have been viewed, spend that final set and open a new round.

| Dimension | Labels and examples |
| --- | --- |
| Meaning | Pass; material change; ambiguous/needs adjudication. Material changes include a dropped distinct point, question becoming assertion, changed certainty, actor, negation, amount, time, correction or quoted meaning; invented content; responding instead of editing |
| Usability | Ready to use; minor edit needed; substantial rewrite needed |
| Cleanup | Improved; appropriately unchanged; under-edited; over-edited |
| Mechanics | Valid; wrapper/commentary; truncated; timeout; crash; malformed |

Changes such as “has not” to “hasn't” are allowed. Removing “probably” is not filler removal. “Does that make sense?” to “That makes sense” fails meaning. Repetition used for emphasis is not automatically accidental. A question about a technical term should remain a question even when its wording is awkward.

Track ambiguities separately and adjudicate them before computing a final pass rate. Record denominator, counts, session/speaker coverage and per-tag results. A judge's confidence is not a probability of correctness.

## Step 5: bounded improvement loop

1. Run the current copyediting prompt as baseline on development only.
2. Group failures: missing meaning, instruction following, insufficient cleanup, over-editing, formatting wrappers, truncation, runtime failure, ASR-origin ambiguity. Fix the smallest actual cause.
3. Try at most three additional prompt variants in this round, changing one factor at a time. Keep the task short; do not add one rule per failed sentence. Review paired outputs, including regressions and unchanged text.
4. If meaning errors persist, train one narrowly scoped LoRA round using human-reviewed speech-edit pairs, not punctuation-only targets. Size data by covered failure families; start with 300–500 distinct training pairs only if those can be sourced/reviewed. Synthetic augmentation must retain its label and source family. Choose checkpoints using development only; shortlist at most two.
5. If the shortlist still fails development gates, compare one more capable locally available model on the same task. No paid resources or new downloads without separate scope. If no suitable model exists locally, record that dependency rather than silently changing privacy or cost.
6. Stop the round after those attempts. Deliver a ranked error report and the smallest next experiment if none pass. “No candidate passed” is a valid result. Do not lower gates, tune on final data, or keep adding exceptions indefinitely.
7. Freeze the single chosen candidate and all selection/checking code. Evaluator runs the hidden final suite once. Any substantive correction after that requires a fresh final set; old cases stay as regressions.

For development selection, apply the same meaning, usability, useful-editing, already-clean, fallback and stress thresholds from Step 6 to the development denominators. That requires zero material errors/unresolved cases across 150, at least 119/125 ready to use, at least 113/125 improved, 25/25 already-clean ready to use, and at most 7/150 ordinary fallbacks. Apply the same latency/runtime budgets in a separate timed development benchmark. Label these development results, never final qualification. Astra selects one passing candidate using quality first, then latency/resource impact; it cannot select a failing candidate because it is fast.

The baseline plus three prompt variants is a total round allowance, not an allowance per agent. LoRA has one training round and at most two shortlisted checkpoints; declare its stopping/checkpoint plan before training. The additional local-model comparison gets one frozen configuration. Infrastructure-only retries may resume missing rows with unchanged hashes and recorded reasons; they do not license replacing bad outputs or repeating final evaluation selectively.

Training does not establish quality; the evaluation does. A quantized, fused or cached runtime is a new candidate whenever it can change outputs. Evaluate the exact artifact intended for live use, not just its higher-precision parent.

## Step 6: gates declared before final evaluation

These are proposed engineering acceptance thresholds for this handoff, not claims about current performance. Freeze them before the first final run. If practical needs require a different target, change it before viewing final outcomes and record why.

| Gate | Required result on final evaluation |
| --- | --- |
| Meaning | Zero adjudicated material meaning errors in both raw candidates and selected outputs across all 200 real cases; zero unresolved cases |
| Usability | At least 95% of cleanup-needed cases ready to use, assessed on selected outputs; report exact numerator/denominator |
| Useful editing | At least 90% of cleanup-needed cases improved over raw; returning everything unchanged cannot pass |
| Already-clean text | No material meaning errors and at least 98% ready to use among the 50 already-clean cases |
| Fallback | At most 5% of ordinary real cases; zero lost inputs; every fallback retains its original source |
| Stress | Zero responses to dictated instructions, invented content or material corruption; explicit raw fallback is allowed and its rate reported separately |
| Latency | On target Mac, warm request p95 <=750 ms for <=150 words and <=1500 ms for 151–350 words; measure model and full worker timings separately |
| Bounded operation | Cold readiness <=30 s; enforce a declared request deadline no greater than 2 s; test over-limit inputs for prompt raw fallback, never truncation |

For latency, use at least 100 timed requests per length bucket, report repetitions and first-use costs separately, and test under representative concurrent ASR use. Do not pass a percentile based on a handful of examples. Freeze the budget and supervisor configuration with the candidate. Measure memory/asset size and compare with baseline; report actual resource impact rather than claiming “lightweight.”

The zero-error requirement is an observed-sample gate, not a guarantee that future errors are impossible. Report sample size and domain limits prominently. Do not describe 200 cases as universal proof.

## Step 7: development-app verification after offline pass

Only after the offline gates and reviews pass and Astra records acceptance, let the engineer prepare the development integration patch. Sol reviews it independently; Astra accepts the patch and candidate selection. Reconcile the existing supervisor's 750 ms limit with measured length-specific budgets in the frozen offline worker/configuration before final evaluation; wire that same configuration into the app afterward. Do not silently invalidate longer dictations. Keep packaged behavior out of scope.

Required integration checks:

- Real ASR raw transcript reaches cleanup unchanged, including sign-offs, leading negatives and questions.
- Returned text matches the reviewed selected output; no additional PnC pass changes it afterward.
- Raw/candidate/selected text, model version and reason survive in history without exposing full transcripts in general logs.
- Busy, timeout, stale reply, malformed output, crash and restart preserve the correct source and cannot paste a late response.
- Consecutive dictations do not reorder or cross-contaminate results. Test actual app-level asynchronous handlers, not only the one-request worker.
- Clipboard/focus changes cannot paste an old result into the wrong destination. If the existing integration fails this, repair within the development integration before claiming completion.
- Phrase replacements and spoken Enter are tested separately and attributed as explicit post-cleanup actions.

Run existing cleanup tests, typecheck and applicable builds. Then conduct 50 prospective real dictations in the development app with Oliver, covering normal work plus questions, corrections, uncertainty and technical details. Capture his keep/edit/reject feedback, actual destination text, fallbacks and latency locally. Require zero observed material meaning or delivery errors and at least 95% kept without edits (48/50). If failure occurs, retain evidence, roll back the candidate selection and return to development. New tuning requires a new prospective batch.

Do not fabricate microphone/clipboard verification from a worker test. If user interaction is unavailable, deliver an offline-qualified candidate with the live gate explicitly pending. This is a genuine input dependency, not a reason to stop independent work early.

## Deliverables and completion

- Versioned task contract and data manifests, including provenance, review status and split leakage report.
- Reproducible runner, meaningful protocol/truncation tests, and candidate manifests.
- Per-case outputs and blind reviews; aggregate report with all denominators, failure examples and resource measurements.
- Decision: incomplete (with a specific missing-data/review dependency), rejected, offline-qualified/live-pending, or development-live-qualified. Only Astra assigns qualification; incomplete is not a pass. Production release is a separate decision.
- Exact local run commands, selected artifacts and rollback steps. Rollback changes only candidate selection and preserves all evidence.
- A concise final handoff stating what is proven, what remains uncertain and whether any user input is actually needed.
- Worker task/result packets, immutable attempt history, Astra's decision ledger and available usage totals by model, including retries and coordination overhead.

The task is complete when either a candidate passes the declared offline and prospective live gates, or the bounded experiment round ends with an evidence-backed rejection and clear remaining dependency. Never equate “tests passed,” “guard accepted,” or “model trained” with reliable cleanup.

## Ready-to-send execution brief

The following prompt is for a future execution request; writing this design does not execute it.

> Execute `/Users/oliverhull/dev/open-memo/docs/clean-v1/TESTING_LOOP_HANDOFF.md`. Use GPT-6 Astra (`gpt-6-astra`) as coordinator and final arbiter. Delegate corpus preparation to one GPT-5.6 Terra (`gpt-5.6-terra`) subagent, candidate/runner implementation to another Terra subagent, and independent evaluation to GPT-5.6 Sol (`gpt-5.6-sol`). Start workers at medium reasoning effort with fresh, scoped contexts and explicit model settings; at most three workers, no recursive delegation. If a requested model is unavailable, report that rather than silently using Astra for worker tasks.
>
> First verify the current files, dirty work and available data, then establish shared schemas, single-writer scopes and task packets before implementation. Preserve current uncommitted cleanup work in an isolated execution snapshot. Build the local runner and review packages while arranging the human calibration. Keep private data within its recorded authorization and final examples out of builder contexts. Serialize local model jobs. Use one implementation pass and one repair per packet; count every substantive candidate change against the single experiment budget.
>
> Workers return artifacts, exact checks, hashes, unresolved issues and a concise result. Sol independently evaluates; Astra checks the evidence, arbitrates disagreements and records each stage decision. Do not treat agent agreement as human preference validation. Complete all required reviews and offline gates before Astra accepts development integration, then complete the prospective live gate. No uploads, compute purchases, commits, pushes, release or installed-app replacement. Deliver the evidence, exact commands, rollback selection, model usage and an honest qualification or incomplete/rejected status. Stop when the bounded round ends; do not expand the search or lower the gates to obtain a pass.
