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

A bad result we caught: _TBD after the judged run: quote one rejection from `room.json`
and the commit that fixed it._

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

_Filled in after the judged run from the coordinator's round records, Band Desktop's usage
view and the Anthropic console._

| Stage | Wall-clock | Repair rounds | Commits | Input tokens | Output tokens | Spend (USD) | Claimed (shipped checks) |
|---|---|---|---|---|---|---|---|
| 1 | | | | | | | |
| 2 | | | | | | | |
| 3 | | | | | | | |
| 4 | | | | | | | |
| **Total** | | | | | | | |

## Limitations

_TBD after the judged run._
