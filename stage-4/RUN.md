# Tablekeeper — Stage 4 (seating changes and recurring amendments)

Zero-dependency Node.js 22 service: `server.js` (API) plus `public/` (bundled browser UI: `/`, `/signup`, `/login`, `/lookup`; no external fonts/scripts). State is in memory.

## Build and start

    docker build -t tablekeeper-stage1 .
    docker run --rm -e PORT=8080 -p 8080:8080 tablekeeper-stage1

Health: `curl localhost:8080/health` -> `{"status":"ok"}`. Nothing is fetched at run time.

Without Docker (Node 22+): `PORT=8080 node server.js`

## Check

    cd <kickoff package>
    .venv/bin/python -m harness run --track tablekeeper --repo <result repo> --stage 4 --mode isolated --out <new folder>

Design notes (concurrency, idempotency, DST) are in comments at the top of `server.js`.
