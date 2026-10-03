# Tablekeeper, built by a dark factory

Our entry to the **tablekeeper** track of *WeAreDevelopers x BAND: AI Dark Factory*.
It is a clean-room OpenTable-style reservation service, built by three coding-agent seats in
Band Desktop from one dispatched task, with no human steering during the run.

## How to read this repository

| Path | What it is |
|---|---|
| [`FACTORY.md`](FACTORY.md) | The factory: seats, setup, design choices, costs, failure handling |
| [`mandates/`](mandates/) | The standing instruction for each seat. Generic: no track detail |
| [`TASK.md`](TASK.md) | The single message dispatched to the coordinator for the judged run |
| `room.json` | The full Band Desktop room the band worked in, downloaded unchanged |
| `stage-1/` … `stage-4/` | One complete, buildable service per stage. Each has a `RUN.md` |

Everything under `stage-N/` was written by the band. Git history is kept exactly as the
seats made it.

## Run a stage

```sh
cd stage-1   # or stage-2, stage-3, stage-4
cat RUN.md
```

## Team

M Safdar

## License

MIT, see [`LICENSE`](LICENSE).
