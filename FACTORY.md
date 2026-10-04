# The factory

Three Claude Code seats in Band Desktop that take a written specification, build it in
stages, and refuse to call a stage done until an independent seat has broken it and failed.
Nothing in `mandates/` names this problem: the same three files run any staged build that
ends in a service, and the task pasted into the room carries everything specific.

## Seats

| Seat | Harness | Model | Owns | Never does |
|---|---|---|---|---|
| `coordinator` | Claude Code | `claude-sonnet-5-5` | The plan, every handoff, the record of revisions and verdicts, the final report | Write code, fix a failing check, ask the human anything |
| `implementer` | Claude Code | `claude-sonnet-5-5` | The code, its build and run instructions, and honest reports of what it ran | Review its own work, special-case a reported input, rewrite history |
| `reviewer` | Claude Code | `claude-sonnet-5-5` | An independent verdict on a committed revision | Edit the work, read the source before forming its own expectation |

The full standing instructions are in [`mandates/`](mandates/). Each file starts with the
`Harness:` and `Model:` lines the seat actually runs.

## Stand it up

1. Install [Band Desktop](https://docs.band.ai/band-desktop.md), sign in, and use the
   app's install buttons until both readiness checks pass (terminal CLI installed,
   `band-peer` plugin installed). Restart Claude Code or run `/reload-plugins`, then
   **Recheck**.
2. Clone the kickoff package and prepare its check runner:
   ```sh
   git clone https://github.com/band-ai/dark-factory-wearedevs
   cd dark-factory-wearedevs
   python3.12 -m venv .venv && .venv/bin/pip install -r harness/requirements.txt
   .venv/bin/python -m playwright install chromium
   ```
3. Create an empty result repository next to it (`band-work/result`, `git init -b main`)
   and copy `mandates/`, `README.md`, `FACTORY.md` and `LICENSE` into it.
4. Create the three seats as Band-owned Claude Code agents. From the result repository
   (`band preflight` should be all `[ok]` first):
   ```sh
   R="$PWD"   # absolute path of the result repository
   for seat in coordinator implementer reviewer; do
     model=$(sed -n 's/^Model: //p' "mandates/$seat.md")
     band agent create --session "$seat" --name "$seat" \
       --description "$seat seat of the factory" --transport claude-code-cli \
       --runtime-model "$model" --cwd "$R" --instructions-file "$R/mandates/$seat.md"
     band runtime template set --session "$seat" --runtime-model "$model"
   done
   band list   # three seats, Connected
   ```
   `--instructions-file` live-links the mandate as the seat's owner instructions (the
   **Role** field in Band Desktop's form). The seats run in Claude Code's `auto`
   permission mode on the host and use the machine's existing Claude login.
5. Create a room, add the three seats, and confirm each seat answers a direct `@handle`
   message. Do this rehearsal in a throwaway room: the judged run needs a fresh one.
6. In a fresh room, send the coordinator the task in [`TASK.md`](TASK.md) (paths adjusted
   to your machine). Send nothing else until the coordinator's final report.
7. Download the room (**Open in Band → Download → Download full session**) and save it
   unchanged as `room.json` at the repository root.

## Design choices and why

**The reviewer builds its own model of the spec before it reads the code.** Shipped checks
cover only part of each stage, and every hidden test is written in the spec. A reviewer that
reads the implementation first ends up confirming it. Our reviewer writes a small, slow,
obviously correct model from the spec alone, then runs seeded random operation sequences
against both: repeats, concurrent calls, lost responses, malformed input and boundaries. Any
difference is a rejection with the seed attached, so the implementer can replay it.

**Handoffs paste the whole requirement, every time.** A Band seat only sees what is
addressed to it. A pointer to an earlier message is a silent truncation, so every handoff
carries the full spec for the unit, the earlier requirements it must keep, the
constraints, the repository path, the checks and every open problem.

**Evidence is a committed revision, not a claim.** The coordinator accepts nothing from a
working tree or a description. Each round records the seat, full revision, checks, verdict,
counts and timestamps. That record is what the costs table below is built from.

**Repair rounds are bounded.** A unit gets one dispatch and up to five repair rounds. After
the fifth rejection the coordinator records the unit as incomplete with the evidence and
moves on where it can. An unattended run has to end, and an honest gap beats a loop.

**Extending never breaks what came before.** Every handoff repeats the earlier requirements,
the implementer runs earlier checks with the new ones, and the reviewer re-checks earlier
behaviour. Accepted work is frozen.

**The reviewer prepares while the implementer builds.** The coordinator sends the reviewer
the same complete requirements as advance notice, in the same turn as the implementer's
dispatch. The reviewer builds its reference model and test generators before any code
exists, so review starts the moment a revision lands instead of after. In the judged run
the reviewer reported ready one to two minutes after each dispatch.

**No chatter.** A seat speaks only to hand off, report a result, reject, or raise a blocker.
No acknowledgements, no "waiting for". Every message costs a turn on every seat it reaches.

**Fast checks while building, full checks before handing off.** The implementer iterates on
its own quick tests and runs the slow, isolated conformance run once before each handoff.
The reviewer runs it again independently.

**Seats stage only what they changed, by name.** Never the whole tree, so no seat's commit
can carry someone else's uncommitted work. This rule came from a failed practice run (below).

**One model for every seat.** All three seats run Sonnet. The factory's reliability comes
from its structure (complete handoffs, an independent reviewer with its own model of the
spec, evidence tied to commits), not from a bigger model in one seat, and one model keeps
cost and rate limits predictable over a long unattended run.

## How it catches and recovers from bad work

| Failure | What catches it | Recovery |
|---|---|---|
| Code passes the shipped checks but not the spec | Reviewer's spec-derived model and seeded random sequences | Rejection with seed, expected vs actual, and the spec clause, sent back to the implementer |
| Special-casing a test input | Reviewer rule 7; implementer may not special-case a reported input | Rejection; fix the cause, add the case to the implementer's own checks |
| Service does not build or start in a clean, offline container | Implementer's pre-handoff clean start; the reviewer builds it first and stops there on failure | Rejection before any functional review |
| A later stage breaks an earlier one | Earlier requirements repeated in every handoff; the reviewer re-checks them | Rejection naming the earlier requirement |
| A seat is missing from the room | Coordinator checks participants before the first handoff | Adds that exact seat and retries; records it if that fails |
| An endless fix loop | Five-round cap | Unit recorded incomplete with evidence; run continues |
| Truncated context | Numbered multi-part handoffs, final part marked, receipt confirmed | Coordinator resends the missing part |
| A defect found at acceptance that does not block the unit | Reviewer lists it as an observation with the spec clause | Coordinator carries it as an open problem into the next unit's handoff; the reviewer re-verifies the fix |

### Bad results it caught in the judged run

All four units were accepted on the first review, so no unit needed a repair round. The
reviewer still found real defects that every shipped check passed, and the coordinator's
carry-forward rule got them fixed:

- **Stage 1 → fixed in stage 2.** PATCH and multi-booking moves on a cancelled or past-cutoff
  booking with an invalid party size answered 422 instead of the conflict the spec puts first.
  The coordinator carried it into the stage 2 handoff, and the implementer fixed it there.
- **Stage 3 → fixed in stage 4.** A booking that was cancelled before an export came back from
  import with a history ending in `created`, but the spec says a cancelled reservation's
  history ends with `cancelled`. The reviewer found it by importing a real export from an
  older stage's container. The coordinator carried it into stage 4. The implementer added the
  synthesized entry, and the reviewer confirmed it: `created` then `cancelled`, revision 2.

Both are quoted, with the revisions involved, in `room.json` (the reviewer's verdicts for
`89575f24` and `f97f37e6`, and the coordinator's final report).

What the reviewer ran before each acceptance, all against the Docker image under the judged
limits (2 vCPU, 2 GiB, no network):

- differential fuzzing against its own spec model (6 to 13 recorded seeds per stage, 0
  differences)
- 20- to 50-way concurrent races
- real exports from older stages' containers imported into the new one
- browser runs at 375 px and 1280 px with a contrast audit
- for stage 4, an independent brute-force planner over about 390 scenarios (74 infeasible),
  with 0 differences

## What we tried that failed

- **Building stage 1 in a single Claude Code session first.** It passed its own tests, but
  hand-steered code does not count, and nothing in it showed which seat did what. We threw
  it away and moved everything that made it good (concurrency reasoning, idempotency, time
  zone care) into generic rules in the mandates instead.
- **Touching the factory while it ran.** In a practice run the operator changed the
  mandates and restarted the seats mid-run, and a `git add -A` for the mandate change
  swept the implementer's uncommitted stage code into the operator's commit. The output
  passed every shipped check, but the history no longer showed who wrote what, so we
  discarded the run. Two rules came out of it: the factory is frozen and committed before
  dispatch, and every seat stages only the paths it changed, by name.
- **Mandates written around the problem.** An early draft was tempting to fill with this
  service's specifics. We rewrote them so each rule is about how a seat works, then checked
  them with `harness check`'s vocabulary scan.

## Measured costs

The judged run is room `787bfb21-ee7b-4f55-9140-3ba4dafe786c` ("Development agents team",
`room.json`), from 2026-10-03 14:53 to 15:59 UTC. It had one human message, the task. The
times are from the coordinator's round records in its final report. The shipped-check
results are from our own isolated rerun of `harness run --all --mode isolated` on the
pushed repository.

| Stage | Wall-clock | Repair rounds | Stage commits | Shipped checks passed (isolated) | Claimed |
|---|---|---|---|---|---|
| 1 | ~8 min | 0 | 1 (`70955a9`) | suite 1: 120/120 | stage 1 |
| 2 | ~26 min | 0 | 1 (`a773ef4`) | suites 1–2: 120/120, 25/25 | stage 2 |
| 3 | ~18 min | 0 | 1 (`89575f2`) | suites 1–3: 120/120, 25/25, 7/7 | stage 3 |
| 4 | ~13 min | 0 | 1 (`f97f37e`) | suites 1–4: 120/120, 25/25, 7/7, 6/6 | stage 4 |
| **Total** | **65 min** | **0** | **4** | every folder claims its own stage and fails the next suite, as required | **4 of 4** |

Model spend for the judged run, per seat. These are `band usage` estimates at list prices,
not a bill; the seats ran on a Claude Max subscription. Most of the tokens are cached prompt
reads from re-pasting complete specs into every handoff.

| Seat | Tokens | Estimated USD |
|---|---|---|
| coordinator | 2.5 M | $1.02 |
| implementer | 11.8 M | $5.06 |
| reviewer | 14.4 M | $5.07 |
| **Total** | **28.8 M** | **$11.16** |

Building the factory also cost a practice run of all four stages ($15.03, discarded; see
above) and three rehearsal rooms for handles and models ($3.09).

The reviewer spends as much as the implementer, which is the design working as intended.
Half the budget goes to independently trying to break the work.

## Limitations

- **Hidden tests.** Shipped checks cover 83% of stage 1 but only 41%, 11% and 21% of stages
  2 to 4. Our evidence for the rest is the reviewer's spec-derived testing, not the judges'
  suite.
- **First-time acceptance.** The reviewer accepted every unit on its first review, and both
  defects it found were fixed one stage later. Accepted folders are frozen, so `stage-3/`
  still carries the imported-cancellation history gap that `stage-4/` fixed. A stricter
  reviewer rule (reject any spec deviation, however small) would trade time for that.
- **Numbers sent as floats.** The service is Node.js, which cannot tell `2.0` from `2`, so a
  whole-number float is accepted where the spec asks for an integer.
- **Not checked by the reviewer:** sustained memory use, browsers other than Chromium, and a
  browser session carried over from an older stage's UI. The worst-case replan size was
  timed only by the implementer (about 3 ms).
- **Final report addressee.** The coordinator posted its final report to the reviewer's
  handle rather than to the human. The content is complete, but the mandate could name the
  recipient.
