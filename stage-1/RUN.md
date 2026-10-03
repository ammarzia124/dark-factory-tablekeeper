# Tablekeeper — Stage 1

Reservations HTTP service. Python 3.12, standard library only: no pip install, no
runtime dependencies, no outbound network needed once the image is built.

## Run it

```sh
docker build -t tablekeeper-stage1 . && docker run --rm -p 8080:8080 -e PORT=8080 tablekeeper-stage1
```

That is the whole setup. The service is healthy when `GET http://localhost:8080/health`
returns `{"status":"ok"}`.

```sh
curl -s localhost:8080/health
```

To use another host port, change the left side of `-p`; the container always listens
on `0.0.0.0:$PORT` (default 8080).

## Run without Docker

```sh
PORT=8080 python app.py
```

Needs Python 3.9+ on a machine with the IANA time zone database (`tzdata`; standard
on Linux/macOS, and on Windows it comes from `tzdata` or the `tzdata` pip package).

## How it is put together

| Concern | Choice |
|---|---|
| HTTP | `ThreadingHTTPServer` from the standard library |
| Storage | In memory; ephemeral is allowed by the spec |
| Concurrency | One `threading.RLock` around every state access |
| Passwords | `hashlib.scrypt`, per-password salt |
| Time zones | `zoneinfo` (IANA) |

The single lock is deliberate: it makes "is this table free?" plus "insert the
booking" one atomic step, so two concurrent requests can never double-book, and it
makes concurrent identical idempotent requests resolve to exactly one 201 with the
others replaying 200. Nothing else is needed to satisfy the concurrency
requirements, and no request path can return a 5xx — unexpected failures are
caught and answered with the 400 error envelope.