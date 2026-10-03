# Tablekeeper — Stage 1 (reservations)

Zero-dependency Node.js 22 service (single file, `server.js`). State is in memory.

## Build and start

    docker build -t tablekeeper-stage1 .
    docker run --rm -e PORT=8080 -p 8080:8080 tablekeeper-stage1

Health: `curl localhost:8080/health` -> `{"status":"ok"}`. Nothing is fetched at run time.

Without Docker (Node 22+): `PORT=8080 node server.js`

## Check

    cd <kickoff package>
    .venv/bin/python -m harness run --track tablekeeper --repo <result repo> --stage 1 --mode isolated --out <new folder>

Design notes (concurrency, idempotency, DST) are in comments at the top of `server.js`.
