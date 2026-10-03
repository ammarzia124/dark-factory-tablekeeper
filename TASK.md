You are the lead seat for our factory. Build all four stages of the tablekeeper track
sequentially, coordinating the other seats, and keep every stage in its own complete,
buildable folder. This message is the only human input for the whole run.

Workspace root: /Users/apple/Desktop/dark-factory-run
Kickoff package (read-only): /Users/apple/Desktop/dark-factory-run/dark-factory-wearedevs
Track: tablekeeper
Result repository: /Users/apple/Desktop/dark-factory-tablekeeper (branch main)
Check output folder: /Users/apple/Desktop/dark-factory-run/band-work/checks-submission

Specifications, one per stage, in order:
- /Users/apple/Desktop/dark-factory-run/dark-factory-wearedevs/tablekeeper/spec/stage-1.md
- /Users/apple/Desktop/dark-factory-run/dark-factory-wearedevs/tablekeeper/spec/stage-2.md
- /Users/apple/Desktop/dark-factory-run/dark-factory-wearedevs/tablekeeper/spec/stage-3.md
- /Users/apple/Desktop/dark-factory-run/dark-factory-wearedevs/tablekeeper/spec/stage-4.md
Read each one in full. Every handoff must paste the complete spec text of the stage it
concerns, plus the requirements of earlier stages it must keep satisfying; a path or a
pointer to this message is not a handoff.

How the stages relate:
- Stage 1 goes in stage-1/. When the reviewer accepts it, copy stage-1/ to stage-2/ and
  widen the copy to the stage 2 spec; the same for stage-3/ and stage-4/. Never edit an
  accepted folder again.
- Each stage-N/ folder holds the solution to stage N and no later stage. It must pass
  every suite from 1 to N and must not implement stage N+1.
- Each folder contains source, a Dockerfile and a RUN.md, and nothing that is its own Git
  repository (no nested .git, no submodules, no symlinks).
- Do not touch anything outside stage-N/ folders in the result repository.

Constraints for every stage:
- The image must build from the folder's Dockerfile and serve from a clean container with
  no outbound network at run time, within 2 vCPU and 2 GiB, healthy within 60 seconds.
  Builds may fetch dependencies; the running service may not.
- Up to 50 requests in flight; each must answer within 5 seconds (10 seconds for the
  state-reset endpoint the spec defines).
- Listen on 0.0.0.0 on the port in the PORT environment variable, default 8080.
- Any language or framework. Pin dependencies.
- The stage 2 browser product must be coherent, presentation-ready and responsive on a
  phone and a desktop, and clear in every state the spec names.

Checks (run from the kickoff package with its virtual environment):
  cd /Users/apple/Desktop/dark-factory-run/dark-factory-wearedevs
  .venv/bin/python -m harness run --track tablekeeper \
    --repo /Users/apple/Desktop/dark-factory-tablekeeper --stage N \
    --mode isolated --out /Users/apple/Desktop/dark-factory-run/band-work/checks-submission/sN-<seat>-<round>
Passing looks like the last line reading `claimed stage: N`. The --out folder must not
exist yet. The next stage's suite is expected to fail. These checks are only part of the
graded tests: the full suite is held back and every hidden test is written in the spec,
so passing them is not evidence that a stage is done. Build and review against the spec.

Git: commit only inside the result repository, on main, with the committing seat's own
name as author (git -c user.name=<seat> -c user.email=<seat>@factory.local commit ...).
Stage only the stage-N/ paths you changed, by name (git add stage-N/...); never git add -A
or git add . at the repository root. Never amend, rebase, squash, push or force-push.
Never commit credentials.

Finish with a final report in the room: per stage, the accepted revision, the checks run
and their results, the review rounds and what each rejection changed, and anything left
incomplete with its evidence.
