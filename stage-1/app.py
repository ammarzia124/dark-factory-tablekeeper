#!/usr/bin/env python3
"""Tablekeeper Stage 1 -- reservations HTTP service. Standard library only.

One process, in-memory state, one re-entrant lock around every state access.
The lock is the whole concurrency story: it makes the double-booking check and
the insert one atomic step, and it makes concurrent identical idempotent
requests resolve to exactly one 201.

Run: PORT=8080 python app.py
"""
from __future__ import annotations

import datetime as dt
import hashlib
import hmac
import json
import os
import re
import secrets
import string
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse
from zoneinfo import ZoneInfo

WEEKDAYS = ("mon", "tue", "wed", "thu", "fri", "sat", "sun")
LOCAL_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$")
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
DIGITS_RE = re.compile(r"^[0-9]+$")
HHMM_RE = re.compile(r"^\d{2}:\d{2}$")
REFERENCE_RE = re.compile(r"^[A-Z0-9]{6,12}$")
EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+$")
REF_ALPHABET = string.ascii_uppercase + string.digits
UTC = dt.timezone.utc
MAX_ID = 64


class ApiError(Exception):
    def __init__(self, status: int, code: str, message: str):
        super().__init__(message)
        self.status, self.code, self.message = status, code, message


def malformed(msg: str = "the request body is not a JSON object"):
    return ApiError(400, "malformed_request", msg)


def invalid(msg: str = "a field is missing or out of range"):
    return ApiError(422, "validation_failed", msg)


def not_found(msg: str = "no such resource"):
    return ApiError(404, "not_found", msg)


# ---- passwords ------------------------------------------------------------

def hash_password(password: str) -> str:
    """scrypt from the standard library -- bcrypt-class, no dependency.

    N=4096/r=8/p=1 is the work factor, not a spec-mandated floor; it is stored
    alongside the salt so it can be raised later without invalidating old hashes.
    """
    salt = secrets.token_bytes(16)
    dk = hashlib.scrypt(password.encode("utf-8"), salt=salt, n=2 ** 12, r=8, p=1, dklen=32)
    return f"scrypt$4096$8$1${salt.hex()}${dk.hex()}"


def verify_password(password: str, stored: str) -> bool:
    try:
        _, n, r, p, salt_hex, dk_hex = stored.split("$")
        expected = bytes.fromhex(dk_hex)
        dk = hashlib.scrypt(password.encode("utf-8"), salt=bytes.fromhex(salt_hex),
                            n=int(n), r=int(r), p=int(p), dklen=len(expected))
    except Exception:
        return False
    return hmac.compare_digest(dk, expected)


# ---- time -----------------------------------------------------------------

def _resolve_local(naive: dt.datetime, tz) -> dt.datetime | None:
    """Aware datetime for a naive local time, or None when it does not exist.

    ``fold=0`` is the default, which resolves an ambiguous fall-back time to its
    FIRST occurrence -- the one before the clocks change, as the spec requires.
    """
    aware = naive.replace(tzinfo=tz)
    if aware.astimezone(UTC).astimezone(tz).replace(tzinfo=None) != naive:
        return None
    return aware


def _parse_local(value: str) -> dt.datetime:
    if not isinstance(value, str) or not LOCAL_RE.match(value):
        raise invalid("starts_at_local must be a bare local YYYY-MM-DDTHH:MM")
    try:
        return dt.datetime.strptime(value, "%Y-%m-%dT%H:%M")
    except ValueError:
        raise invalid("starts_at_local is not a real date and time") from None


def _minutes(hhmm: str) -> int:
    h, m = hhmm.split(":")
    return int(h) * 60 + int(m)


def _add_minutes(aware: dt.datetime, minutes: int, tz) -> dt.datetime:
    """Absolute-time addition.

    `aware + timedelta` is WALL-CLOCK arithmetic whenever tzinfo is a ZoneInfo, so
    a 90-minute booking across the Berlin fall-back would read 03:00 instead of
    02:00. Go through UTC, which is the only zone where the two agree.
    """
    return (aware.astimezone(UTC) + dt.timedelta(minutes=minutes)).astimezone(tz)


def _hours_for(rest: dict, date: dt.date) -> dict | None:
    """The opening_hours entry for this local date, or None when closed."""
    weekday = WEEKDAYS[date.weekday()]
    for entry in rest["opening_hours"]:
        if entry["weekday"] == weekday:
            return entry
    return None


def _slots_for(rest: dict, date: dt.date):
    """(starts_at_local, aware) for every slot with room before closing."""
    hours = _hours_for(rest, date)
    if hours is None:
        return []
    tz = ZoneInfo(rest["timezone"])
    opens, closes = _minutes(hours["opens"]), _minutes(hours["closes"])
    step, duration = rest["slot_minutes"], rest["reservation_duration_minutes"]
    out, cursor = [], opens
    while cursor + duration <= closes:
        naive = dt.datetime.combine(date, dt.time(cursor // 60, cursor % 60))
        aware = _resolve_local(naive, tz)
        if aware is not None:  # a skipped local time never appears in availability
            out.append((naive.strftime("%Y-%m-%dT%H:%M"), aware))
        cursor += step
    return out


# ---- state ----------------------------------------------------------------

LOCK = threading.RLock()
STATE: dict = {}


def _empty_state() -> dict:
    return {"users": {}, "tokens": {}, "restaurants": {}, "reservations": {}, "receipts": {}}


def _reservation_view(rec: dict) -> dict:
    return {
        "reservation_id": rec["id"], "reference": rec["reference"],
        "restaurant_id": rec["restaurant_id"], "table_id": rec["table_id"],
        "party_size": rec["party_size"], "status": rec["status"],
        "starts_at_local": rec["starts_at_local"], "starts_at": rec["starts_at"],
        "ends_at": rec["ends_at"], "created_at": rec["created_at"],
    }


def _table(rest: dict, table_id: str) -> dict:
    for entry in rest["tables"]:
        if entry["id"] == table_id:
            return entry
    raise not_found("no such table in this restaurant")


def _restaurant(rid: str) -> dict:
    rest = STATE["restaurants"].get(rid)
    if rest is None:
        raise not_found("no such restaurant")
    return rest


def _new_reference() -> str:
    for _ in range(100):
        candidate = "".join(secrets.choice(REF_ALPHABET) for _ in range(8))
        if not any(r["reference"] == candidate for r in STATE["reservations"].values()):
            return candidate
    raise ApiError(500, "x", "no reference")  # pragma: no cover - unreachable in practice


def _conflicts(restaurant_id: str, table_id: str, start: float, end: float,
               exclude_id: str | None = None) -> bool:
    for rec in STATE["reservations"].values():
        if rec["id"] == exclude_id or rec["status"] != "confirmed":
            continue
        if rec["restaurant_id"] != restaurant_id or rec["table_id"] != table_id:
            continue
        # half-open [starts_at, ends_at): a 19:00-20:30 booking does not overlap 20:30
        if start < rec["end_epoch"] and rec["start_epoch"] < end:
            return True
    return False


def _cutoff_passed(rest: dict, rec: dict) -> bool:
    now = dt.datetime.now(UTC).timestamp()
    return now >= rec["start_epoch"] - rest["cancellation_cutoff_minutes"] * 60


# ---- request field helpers ------------------------------------------------

def _json_body(raw: bytes) -> dict:
    if not raw:
        raise malformed("a JSON object body is required")
    try:
        body = json.loads(raw.decode("utf-8"))
    except Exception:
        raise malformed("the body is not valid JSON") from None
    if not isinstance(body, dict):
        raise malformed("the body is not a JSON object")
    return body


def _str_field(body: dict, name: str, required: bool = True) -> str | None:
    if name not in body or body[name] is None:
        if required:
            raise invalid(f"{name} is required")
        return None
    value = body[name]
    if not isinstance(value, str):
        raise malformed(f"{name} must be a string")
    return value


def _party_size(value) -> int:
    # Endpoint rule from §5: strings and booleans included, this is never a 400.
    if isinstance(value, bool) or not isinstance(value, int) or value < 1:
        raise invalid("party_size must be an integer of at least 1")
    return value


def _int_param(query: dict, name: str) -> int:
    values = query.get(name)
    if not values or not values[0]:
        raise invalid(f"{name} is required")
    raw = values[0]
    if not DIGITS_RE.match(raw):
        raise invalid(f"{name} must be plain decimal digits")
    return int(raw)


# ---- idempotency ----------------------------------------------------------

def _idem_header(headers) -> str:
    key = headers.get("Idempotency-Key")
    if key is None or not key.strip():
        raise ApiError(400, "missing_idempotency_key",
                       "an Idempotency-Key header is required")
    if not 1 <= len(key) <= 255:
        raise invalid("Idempotency-Key must be 1 to 255 characters")
    return key


def _idem_begin(user_id: str, path: str, key: str, body: dict):
    """Resolve the key before any endpoint-specific validation (§7).

    Returns (None, None, receipt) for a replay, or (receipt_key, canonical_body, None)
    for a first use. Raises 409 when the key was used with a different body.
    """
    receipt_key = f"{user_id}\x00{path}\x00{key}"
    canonical = json.dumps(body, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    receipt = STATE["receipts"].get(receipt_key)
    if receipt is not None:
        if receipt["body"] == canonical:
            return None, None, receipt
        raise ApiError(409, "idempotency_key_reuse",
                       "this idempotency key was used with a different request body")
    return receipt_key, canonical, None


# ---- booking rules --------------------------------------------------------

def _validate_booking(rest: dict, table_id: str, starts_local: str, party: int):
    """Every rule a create or an amendment shares. Returns (table, aware start)."""
    table = _table(rest, table_id)
    aware = _resolve_local(_parse_local(starts_local), ZoneInfo(rest["timezone"]))
    if aware is None:
        raise ApiError(422, "invalid_local_time",
                       "that local time does not exist at this restaurant")
    _check_slot(rest, starts_local, aware)
    if party > table["capacity"]:
        raise ApiError(422, "party_exceeds_capacity",
                       "the party is larger than this table")
    return table, aware


def _check_slot(rest: dict, starts_local: str, aware: dt.datetime) -> None:
    naive = _parse_local(starts_local)
    hours = _hours_for(rest, naive.date())
    if hours is None:
        raise ApiError(422, "outside_opening_hours", "the restaurant is closed that day")
    opens, closes = _minutes(hours["opens"]), _minutes(hours["closes"])
    minute = naive.hour * 60 + naive.minute
    if minute < opens or minute + rest["reservation_duration_minutes"] > closes:
        raise ApiError(422, "outside_opening_hours",
                       "the booking would fall outside opening hours")
    if (minute - opens) % rest["slot_minutes"] != 0:
        raise ApiError(422, "not_on_slot_grid", "the start is not on the slot grid")


def _make_record(user_id: str, restaurant_id: str, table_id: str, starts_local: str,
                 party: int, aware: dt.datetime, rest: dict,
                 reference: str | None = None, res_id: str | None = None) -> dict:
    ends = _add_minutes(aware, rest["reservation_duration_minutes"],
                        ZoneInfo(rest["timezone"]))
    return {
        "id": res_id or f"res_{secrets.token_hex(8)}",
        "reference": reference or _new_reference(),
        "user_id": user_id, "restaurant_id": restaurant_id, "table_id": table_id,
        "party_size": party, "status": "confirmed",
        "starts_at_local": starts_local,
        "starts_at": aware.isoformat(), "ends_at": ends.isoformat(),
        "created_at": dt.datetime.now(UTC).isoformat(),
        "start_epoch": aware.timestamp(), "end_epoch": ends.timestamp(),
    }


# ---- endpoints ------------------------------------------------------------

def h_health(_ctx):
    return 200, {"status": "ok"}


def h_reset(_ctx):
    """Replace all state. Validated first, so a bad fixture changes nothing."""
    fixture = _json_body(_ctx["body"])
    users, restaurants, reservations = _validate_fixture(fixture)
    fresh = _empty_state()
    for user in users:
        fresh["users"][user["id"]] = {
            "id": user["id"], "email": user["email"].lower(),
            "password_hash": hash_password(user["password"]),
            "display_name": user.get("display_name", user["id"]),
        }
    for rid, rest in restaurants.items():
        fresh["restaurants"][rid] = rest
    for rec in reservations:
        fresh["reservations"][rec["id"]] = rec
    STATE.clear()
    STATE.update(fresh)
    return 204, None


def _require_id(value, what: str) -> str:
    if not isinstance(value, str) or not 1 <= len(value) <= MAX_ID:
        raise invalid(f"{what} must be a string of 1 to {MAX_ID} characters")
    return value


def _validate_fixture(fixture: dict):
    for key in ("users", "restaurants", "reservations"):
        if key in fixture and not isinstance(fixture[key], list):
            raise malformed(f"{key} must be a list")
    users = fixture.get("users") or []
    restaurants: dict = {}
    for rest in fixture.get("restaurants") or []:
        if not isinstance(rest, dict):
            raise malformed("a restaurant must be an object")
        rid = _require_id(rest.get("id"), "restaurant id")
        try:
            ZoneInfo(rest.get("timezone", ""))
        except Exception:
            raise invalid("unknown IANA timezone") from None
        for key in ("slot_minutes", "reservation_duration_minutes"):
            value = rest.get(key)
            if isinstance(value, bool) or not isinstance(value, int) or value < 1:
                raise invalid(f"{key} must be a positive integer")
        cutoff = rest.get("cancellation_cutoff_minutes", 0)
        if isinstance(cutoff, bool) or not isinstance(cutoff, int) or cutoff < 0:
            raise invalid("cancellation_cutoff_minutes must be a non-negative integer")
        hours = rest.get("opening_hours") or []
        if not isinstance(hours, list):
            raise malformed("opening_hours must be a list")
        for entry in hours:
            if not isinstance(entry, dict) or entry.get("weekday") not in WEEKDAYS:
                raise invalid("opening_hours entries need a known weekday")
            for bound in ("opens", "closes"):
                if not HHMM_RE.match(str(entry.get(bound, ""))):
                    raise invalid(f"{bound} must be HH:MM")
            if _minutes(entry["closes"]) <= _minutes(entry["opens"]):
                raise invalid("closes must be later than opens")
        tables = rest.get("tables") or []
        if not isinstance(tables, list):
            raise malformed("tables must be a list")
        for table in tables:
            if not isinstance(table, dict):
                raise malformed("a table must be an object")
            _require_id(table.get("id"), "table id")
            capacity = table.get("capacity")
            if isinstance(capacity, bool) or not isinstance(capacity, int) or capacity < 0:
                raise invalid("capacity must be a non-negative integer")
        restaurants[rid] = {
            "id": rid, "name": rest.get("name", rid),
            "timezone": rest["timezone"],
            "slot_minutes": rest["slot_minutes"],
            "reservation_duration_minutes": rest["reservation_duration_minutes"],
            "cancellation_cutoff_minutes": cutoff,
            "opening_hours": hours, "tables": tables,
        }

    seen_emails = set()
    for user in users:
        if not isinstance(user, dict):
            raise malformed("a user must be an object")
        _require_id(user.get("id"), "user id")
        email = user.get("email")
        if not isinstance(email, str) or not EMAIL_RE.match(email):
            raise invalid("a seeded user needs an email of the form local@domain")
        if email.lower() in seen_emails:
            raise invalid("duplicate email in the fixture")
        seen_emails.add(email.lower())
        if not isinstance(user.get("password"), str) or not user["password"]:
            raise invalid("a seeded user needs a password")

    reservations = []
    for seed in fixture.get("reservations") or []:
        if not isinstance(seed, dict):
            raise malformed("a reservation must be an object")
        for key in ("id", "reference", "user_id", "restaurant_id", "table_id"):
            _require_id(seed.get(key), f"reservation {key}")
        if not REFERENCE_RE.match(seed["reference"]):
            raise invalid("a reservation reference must be 6 to 12 characters of A-Z0-9")
        rest = restaurants.get(seed["restaurant_id"])
        if rest is None:
            raise invalid("a seeded reservation needs a known restaurant")
        party = _party_size(seed.get("party_size"))
        starts_local = _str_field(seed, "starts_at_local")
        aware = _resolve_local(_parse_local(starts_local), ZoneInfo(rest["timezone"]))
        if aware is None:
            raise invalid("a seeded reservation needs an existing local time")
        ends = _add_minutes(aware, rest["reservation_duration_minutes"],
                            ZoneInfo(rest["timezone"]))
        created = seed.get("created_at") or dt.datetime.now(UTC).isoformat()
        reservations.append({
            "id": seed["id"], "reference": seed["reference"],
            "user_id": seed["user_id"], "restaurant_id": seed["restaurant_id"],
            "table_id": seed["table_id"], "party_size": party,
            "status": seed.get("status", "confirmed"),
            "starts_at_local": starts_local,
            "starts_at": aware.isoformat(), "ends_at": ends.isoformat(),
            "created_at": created,
            "start_epoch": aware.timestamp(), "end_epoch": ends.timestamp(),
        })
    return users, restaurants, reservations


def h_export(_ctx):
    # The lock makes this a consistent, read-only snapshot.
    return 200, {"track": "tablekeeper", "format_version": 1, "state": {
        "users": list(STATE["users"].values()),
        "tokens": dict(STATE["tokens"]),
        "restaurants": list(STATE["restaurants"].values()),
        "reservations": list(STATE["reservations"].values()),
        "receipts": [{"key": key, **receipt} for key, receipt in STATE["receipts"].items()],
    }}


def h_import(_ctx):
    payload = _json_body(_ctx["body"])
    if payload.get("track") != "tablekeeper":
        raise invalid("import needs track 'tablekeeper'")
    if payload.get("format_version") != 1:
        raise invalid("unsupported format_version")
    state = payload.get("state")
    if not isinstance(state, dict):
        raise invalid("import needs a state object")
    for key in ("users", "tokens", "restaurants", "reservations", "receipts"):
        if not isinstance(state.get(key), list if key != "tokens" else dict):
            raise invalid(f"state.{key} is missing or of the wrong shape")
    fresh = _empty_state()
    try:
        for user in state["users"]:
            fresh["users"][user["id"]] = dict(user)
        fresh["tokens"] = dict(state["tokens"])
        for rest in state["restaurants"]:
            fresh["restaurants"][rest["id"]] = dict(rest)
        for rec in state["reservations"]:
            fresh["reservations"][rec["id"]] = dict(rec)
        for receipt in state["receipts"]:
            fresh["receipts"][receipt["key"]] = {
                "body": receipt["body"], "status": receipt["status"],
                "response": receipt["response"]}
    except (KeyError, TypeError, AttributeError):
        raise invalid("the state object is not usable") from None
    # Atomic replace: nothing above touched STATE.
    STATE.clear()
    STATE.update(fresh)
    return 204, None


def h_signup(_ctx):
    body = _json_body(_ctx["body"])
    email = _str_field(body, "email")
    password = _str_field(body, "password")
    display_name = _str_field(body, "display_name", required=False) or email.split("@")[0]
    if not EMAIL_RE.match(email):
        raise invalid("email must be of the form local@domain")
    if len(password) < 8:
        raise invalid("password must be at least 8 characters")
    for user in STATE["users"].values():
        if user["email"] == email.lower():
            raise ApiError(409, "email_taken", "that email is already registered")
    user_id = f"u_{secrets.token_hex(8)}"
    token = secrets.token_urlsafe(32)
    STATE["users"][user_id] = {"id": user_id, "email": email.lower(),
                               "password_hash": hash_password(password),
                               "display_name": display_name}
    STATE["tokens"][token] = user_id
    return 201, {"user_id": user_id, "display_name": display_name, "token": token}


def h_login(_ctx):
    body = _json_body(_ctx["body"])
    email = _str_field(body, "email")
    password = _str_field(body, "password")
    for user in STATE["users"].values():
        if user["email"] == email.lower() and verify_password(password, user["password_hash"]):
            token = secrets.token_urlsafe(32)
            STATE["tokens"][token] = user["id"]
            return 200, {"user_id": user["id"], "display_name": user["display_name"],
                         "token": token}
    raise ApiError(401, "unauthenticated", "wrong email or password")


def h_restaurants(_ctx):
    return 200, {"restaurants": [{"id": r["id"], "name": r["name"],
                                  "timezone": r["timezone"]}
                                 for r in STATE["restaurants"].values()]}


def h_restaurant(_ctx):
    return 200, dict(_restaurant(_ctx["match"].group(1)))


def h_availability(_ctx):
    query = _ctx["query"]
    rid = query.get("restaurant_id", [""])[0]
    date_raw = query.get("date", [""])[0]
    if not rid:
        raise invalid("restaurant_id is required")
    if not date_raw:
        raise invalid("date is required")
    party = _int_param(query, "party_size")
    if party < 1:
        raise invalid("party_size must be at least 1")
    if not DATE_RE.match(date_raw):
        raise invalid("date must be YYYY-MM-DD")
    try:
        date = dt.date.fromisoformat(date_raw)
    except ValueError:
        raise invalid("date is not a real calendar date") from None
    rest = _restaurant(rid)
    slots = []
    for starts_local, aware in _slots_for(rest, date):
        free = [t["id"] for t in rest["tables"]
                if t["capacity"] >= party
                and not _conflicts(rid, t["id"], aware.timestamp(),
                                   aware.timestamp() + rest["reservation_duration_minutes"] * 60)]
        slots.append({"starts_at_local": starts_local, "starts_at": aware.isoformat(),
                      "available_table_ids": free})
    return 200, {"restaurant_id": rid, "date": date_raw, "timezone": rest["timezone"],
                 "slots": slots}


def h_create_reservation(ctx):
    user_id = ctx["user_id"]
    key = _idem_header(ctx["headers"])
    body = _json_body(ctx["body"])
    receipt_key, canonical, replay = _idem_begin(user_id, "/reservations", key, body)
    if receipt_key is None:
        return 200, replay["response"]

    table_id = _str_field(body, "table_id")
    starts_local = _str_field(body, "starts_at_local")
    party = _party_size(body.get("party_size"))
    rest = _restaurant(_str_field(body, "restaurant_id"))
    _validate_booking(rest, table_id, starts_local, party)
    aware = _resolve_local(_parse_local(starts_local), ZoneInfo(rest["timezone"]))
    start, end = aware.timestamp(), aware.timestamp() + rest["reservation_duration_minutes"] * 60
    if _conflicts(rest["id"], table_id, start, end):
        raise ApiError(409, "table_unavailable", "that table is already booked")

    rec = _make_record(user_id, rest["id"], table_id, starts_local, party, aware, rest)
    view = _reservation_view(rec)
    STATE["reservations"][rec["id"]] = rec
    STATE["receipts"][receipt_key] = {"body": canonical, "status": 201, "response": view}
    return 201, view


def h_list_reservations(ctx):
    mine = [r for r in STATE["reservations"].values() if r["user_id"] == ctx["user_id"]]
    mine.sort(key=lambda r: r["start_epoch"], reverse=True)
    return 200, {"reservations": [_reservation_view(r) for r in mine]}


def _own_reservation(ctx) -> dict:
    rec = None
    for candidate in STATE["reservations"].values():
        if candidate["reference"] == ctx["match"].group(1):
            rec = candidate
            break
    # Another owner's booking is a 404, not a 403 -- never leak its existence.
    if rec is None or rec["user_id"] != ctx["user_id"]:
        raise not_found("no such reservation")
    return rec


def h_get_reservation(ctx):
    return 200, _reservation_view(_own_reservation(ctx))


def h_cancel(ctx):
    rec = _own_reservation(ctx)
    if rec["status"] == "cancelled":
        return 200, _reservation_view(rec)
    rest = _restaurant(rec["restaurant_id"])
    if _cutoff_passed(rest, rec):
        raise ApiError(409, "cutoff_passed", "this booking can no longer be cancelled")
    rec["status"] = "cancelled"
    return 200, _reservation_view(rec)


def _apply_change(ctx, rec: dict, body: dict) -> dict:
    """The amendment shared by PATCH and reservation-moves. Never mutates on error."""
    rest = _restaurant(rec["restaurant_id"])
    table_id = _str_field(body, "table_id", required=False)
    starts_local = _str_field(body, "starts_at_local", required=False)
    party = rec["party_size"] if "party_size" not in body else _party_size(body["party_size"])
    table_id = table_id or rec["table_id"]
    starts_local = starts_local or rec["starts_at_local"]
    _validate_booking(rest, table_id, starts_local, party)
    aware = _resolve_local(_parse_local(starts_local), ZoneInfo(rest["timezone"]))
    return _make_record(ctx["user_id"], rec["restaurant_id"], table_id, starts_local,
                        party, aware, rest, reference=rec["reference"], res_id=rec["id"])


def h_patch(ctx):
    body = _json_body(ctx["body"])
    rec = _own_reservation(ctx)
    if rec["status"] == "cancelled":
        raise ApiError(409, "reservation_cancelled", "this reservation was cancelled")
    rest = _restaurant(rec["restaurant_id"])
    if _cutoff_passed(rest, rec):
        raise ApiError(409, "cutoff_passed", "this booking can no longer be changed")
    updated = _apply_change(ctx, rec, body)
    updated["created_at"] = rec["created_at"]
    if _conflicts(rec["restaurant_id"], updated["table_id"],
                  updated["start_epoch"], updated["end_epoch"], exclude_id=rec["id"]):
        raise ApiError(409, "table_unavailable", "that table is already booked")
    STATE["reservations"][rec["id"]] = updated
    return 200, _reservation_view(updated)


def h_moves(ctx):
    user_id = ctx["user_id"]
    key = _idem_header(ctx["headers"])
    body = _json_body(ctx["body"])
    receipt_key, canonical, replay = _idem_begin(user_id, "/reservation-moves", key, body)
    if receipt_key is None:
        return 200, replay["response"]

    moves = body.get("moves")
    if not isinstance(moves, list) or not 1 <= len(moves) <= 8:
        raise invalid("moves must be a list of 1 to 8 objects")
    seen, targets = set(), []
    for move in moves:
        if not isinstance(move, dict):
            raise invalid("each move must be an object")
        reference = _str_field(move, "reference")
        if not reference or reference in seen:
            raise invalid("moves need distinct references")
        seen.add(reference)

        rec = None
        for candidate in STATE["reservations"].values():
            if candidate["reference"] == reference:
                rec = candidate
                break
        if rec is None or rec["user_id"] != user_id:
            raise not_found("no such reservation")
        targets.append((move, rec))
    if len({r["restaurant_id"] for _, r in targets}) != 1:
        raise invalid("every booking must belong to the same restaurant")

    # Non-occupancy errors take precedence in input order; cutoff before other changes.
    updated = []
    for move, rec in targets:
        if rec["status"] == "cancelled":
            raise ApiError(409, "reservation_cancelled", "this reservation was cancelled")
        if _cutoff_passed(_restaurant(rec["restaurant_id"]), rec):
            raise ApiError(409, "cutoff_passed", "this booking can no longer be changed")
        candidate = _apply_change(ctx, rec, move)
        candidate["created_at"] = rec["created_at"]
        updated.append(candidate)

    # ponytail: O(n^2) over the whole reservation set, which is small at this
    # stage's scale. Index by (restaurant, table) with a sorted-interval sweep
    # if booking volume ever makes this measurable.
    proposed = {rid: dict(rec) for rid, rec in STATE["reservations"].items()}
    for candidate in updated:
        proposed[candidate["id"]] = candidate
    confirmed = [r for r in proposed.values() if r["status"] == "confirmed"]
    for i, left in enumerate(confirmed):
        for right in confirmed[i + 1:]:
            if left["restaurant_id"] != right["restaurant_id"] or left["table_id"] != right["table_id"]:
                continue
            if left["start_epoch"] < right["end_epoch"] and right["start_epoch"] < left["end_epoch"]:
                raise ApiError(409, "table_unavailable",
                               "these bookings would overlap on one table")

    for candidate in updated:  # all-or-nothing: commit only once every check passed
        STATE["reservations"][candidate["id"]] = candidate
    response = {"reservations": [_reservation_view(c) for c in updated]}
    STATE["receipts"][receipt_key] = {"body": canonical, "status": 201, "response": response}
    return 201, response


# ---- routing --------------------------------------------------------------

ROUTES = [
    ("GET", r"^/health$", h_health, True),
    ("POST", r"^/_test/reset$", h_reset, True),
    ("GET", r"^/_test/export$", h_export, True),
    ("POST", r"^/_test/import$", h_import, True),
    ("POST", r"^/auth/signup$", h_signup, True),
    ("POST", r"^/auth/login$", h_login, True),
    ("GET", r"^/restaurants$", h_restaurants, True),
    ("GET", r"^/restaurants/([^/]+)$", h_restaurant, True),
    ("GET", r"^/availability$", h_availability, True),
    ("POST", r"^/reservations$", h_create_reservation, False),
    ("GET", r"^/reservations$", h_list_reservations, False),
    ("GET", r"^/reservations/([^/]+)$", h_get_reservation, False),
    ("POST", r"^/reservations/([^/]+)/cancel$", h_cancel, False),
    ("PATCH", r"^/reservations/([^/]+)$", h_patch, False),
    ("POST", r"^/reservation-moves$", h_moves, False),
]
COMPILED = [(m, re.compile(p), h, public) for m, p, h, public in ROUTES]


def dispatch(method: str, raw_path: str, headers, body: bytes):
    parsed = urlparse(raw_path)
    path = parsed.path.rstrip("/") or "/"
    query = parse_qs(parsed.query, keep_blank_values=True)
    route = next(((m, rx, h, pub) for m, rx, h, pub in COMPILED
                  if m == method and rx.match(path)), None)
    if route is None:
        raise not_found("no such endpoint")

    user_id = None
    if not route[3]:
        auth = headers.get("Authorization") or ""
        if not auth.startswith("Bearer "):
            raise ApiError(401, "unauthenticated", "a bearer token is required")
        user_id = STATE["tokens"].get(auth[7:].strip())
        if user_id is None:
            raise ApiError(401, "unauthenticated", "unknown or malformed bearer token")

    ctx = {"body": body, "query": query, "headers": headers, "match": route[1].match(path),
           "user_id": user_id}
    with LOCK:  # one writer at a time: no check-then-insert race, no partial commit
        return route[2](ctx)


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "tablekeeper/1.0"
    # Headers and body are separate writes; without TCP_NODELAY the second one
    # waits on a delayed ACK and every request pays ~2 s. Do not turn this off.
    disable_nagle_algorithm = True

    def log_message(self, *_args):  # 50 in-flight requests would drown the log
        pass

    def _read_body(self) -> bytes:
        length = int(self.headers.get("Content-Length") or 0)
        return self.rfile.read(length) if length > 0 else b""

    def _respond(self, status: int, payload) -> None:
        raw = b"" if payload is None else json.dumps(payload).encode("utf-8")
        self.send_response(status)
        if payload is not None:
            self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        if raw:
            self.wfile.write(raw)

    def _handle(self, method: str) -> None:
        try:
            status, payload = dispatch(method, self.path, self.headers, self._read_body())
        except ApiError as err:
            self._respond(err.status, {"error": {"code": err.code, "message": err.message}})
        except Exception:  # §5: never a 5xx, not even on an unexpected path
            import traceback
            traceback.print_exc(file=sys.stderr)
            self._respond(400, {"error": {"code": "malformed_request",
                                          "message": "the request could not be processed"}})
        else:
            self._respond(status, payload)

    def do_GET(self):
        self._handle("GET")

    def do_POST(self):
        self._handle("POST")

    def do_PATCH(self):
        self._handle("PATCH")

    def do_PUT(self):
        self._handle("PUT")

    def do_DELETE(self):
        self._handle("DELETE")


def main() -> None:
    STATE.update(_empty_state())
    port = int(os.environ.get("PORT", "8080"))
    server = ThreadingHTTPServer(("0.0.0.0", port), Handler)
    server.daemon_threads = True
    server.request_queue_size = 256
    server.serve_forever()


if __name__ == "__main__":
    main()