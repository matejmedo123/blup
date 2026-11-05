"""Licences for the self-hosted Trader: which plan this installation runs on. Stdlib only.

A licence is a small JSON file the seller signs with a private RSA key (deploy/license-tool.py) and the customer puts
in the state folder (``traderctl license install``). The bot checks the signature with the public key in
``shared/license_key.json`` — no server is asked, nothing is sent anywhere.

* No licence: everything runs on the simulator, every feature included — the free trial.
* ``start``: a real broker (Bybit, Alpaca) for the trend rules.
* ``pro`` and ``max``: also the funding squeeze, leverage, established meme coins, the AI desk and the comparison bot.

A licence that ran out stops new entries on a real broker; open positions keep their stops and exits. A build
without ``shared/license_key.json`` is the seller's own: nothing is locked.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import secrets
from datetime import date
from pathlib import Path

from . import market_clock, state

FILE = "license.json"
KEY_FILE = Path(__file__).resolve().parent / "license_key.json"
PLANS = ("free", "start", "pro", "max")
NEEDS = {"real_broker": "start", "funding_squeeze": "pro", "leverage": "pro", "memes": "pro", "ai_desk": "pro",
         "comparison_bot": "pro"}
LABEL = {"free": "Free (simulator)", "start": "Štart", "pro": "Pro", "max": "Max"}
FEATURE_TEXT = {"real_broker": "a real broker (Bybit, Alpaca)", "funding_squeeze": "the funding-squeeze rule",
                "leverage": "leverage", "memes": "established meme coins", "ai_desk": "the AI desk",
                "comparison_bot": "the comparison bot"}
# DER prefix of a SHA-256 DigestInfo (RFC 8017, 9.2): the hash a PKCS #1 v1.5 signature carries
_SHA256_INFO = bytes.fromhex("3031300d060960864801650304020105000420")


# ---------------------------------------------------------------------------------------------- RSA, stdlib only

def _b64(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).decode("ascii").rstrip("=")


def _unb64(s: str) -> bytes:
    s = str(s or "")
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def _encode(message: bytes, k: int) -> bytes:
    t = _SHA256_INFO + hashlib.sha256(message).digest()
    if k < len(t) + 11:
        raise ValueError("key too short")
    return b"\x00\x01" + b"\xff" * (k - len(t) - 3) + b"\x00" + t


def sign(message: bytes, key: dict) -> bytes:
    n, d = int(key["n"]), int(key["d"])
    k = (n.bit_length() + 7) // 8
    return pow(int.from_bytes(_encode(message, k), "big"), d, n).to_bytes(k, "big")


def verify(message: bytes, signature: bytes, key: dict) -> bool:
    n, e = int(key["n"]), int(key["e"])
    k = (n.bit_length() + 7) // 8
    if len(signature) != k:
        return False
    s = int.from_bytes(signature, "big")
    if s >= n:
        return False
    return hmac.compare_digest(pow(s, e, n).to_bytes(k, "big"), _encode(message, k))


def _probable_prime(n: int) -> bool:
    if n < 2:
        return False
    for p in (2, 3, 5, 7, 11, 13, 17, 19, 23, 29, 31, 37):
        if n % p == 0:
            return n == p
    d, r = n - 1, 0
    while d % 2 == 0:
        d, r = d // 2, r + 1
    for _ in range(40):
        x = pow(secrets.randbelow(n - 3) + 2, d, n)
        if x in (1, n - 1):
            continue
        for _ in range(r - 1):
            x = pow(x, 2, n)
            if x == n - 1:
                break
        else:
            return False
    return True


def _prime(bits: int) -> int:
    while True:
        c = secrets.randbits(bits) | (1 << (bits - 1)) | (1 << (bits - 2)) | 1
        if _probable_prime(c):
            return c


def keygen(bits: int = 3072) -> dict:
    """A new RSA key pair: {"n", "e", "d"}. The public part is {"n", "e"}."""
    e = 65537
    while True:
        p, q = _prime(bits // 2), _prime(bits // 2)
        phi = (p - 1) * (q - 1)
        if p != q and phi % e:
            n = p * q
            if n.bit_length() == bits:
                return {"n": str(n), "e": e, "d": str(pow(e, -1, phi))}


# ---------------------------------------------------------------------------------------------- licence files

def issue(key: dict, email: str, plan: str, expires: str, instances: int = 1, lic_id: str = None) -> dict:
    if plan not in PLANS[1:]:
        raise ValueError("plan must be one of start, pro, max")
    date.fromisoformat(expires)
    payload = {"v": 1, "id": lic_id or secrets.token_hex(6), "email": str(email).strip(), "plan": plan,
               "expires": expires, "instances": int(instances),
               "issued": market_clock.iso(market_clock.now_utc())[:10]}
    raw = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return {"licence": _b64(raw), "signature": _b64(sign(raw, key))}


def public_key():
    path = Path(os.environ.get("TRADER_LICENSE_KEY") or KEY_FILE)
    try:
        doc = json.loads(path.read_text(encoding="utf-8"))
        return {"n": int(doc["n"]), "e": int(doc["e"])}
    except (OSError, ValueError, KeyError, TypeError):
        return None


def read(doc: dict, key: dict = None) -> dict:
    """The licence's contents if its signature holds, else raises ValueError with why."""
    key = key or public_key()
    if key is None:
        raise ValueError("this build has no licence key")
    if not isinstance(doc, dict) or "licence" not in doc or "signature" not in doc:
        raise ValueError("not a licence file")
    try:
        raw, sig = _unb64(doc["licence"]), _unb64(doc["signature"])
    except (ValueError, TypeError):
        raise ValueError("the licence is damaged")
    if not verify(raw, sig, key):
        raise ValueError("the signature does not match — not a licence from this seller, or edited")
    payload = json.loads(raw.decode("utf-8"))
    if payload.get("plan") not in PLANS[1:]:
        raise ValueError("unknown plan")
    return payload


def _mask(email: str) -> str:
    name, _, dom = str(email or "").partition("@")
    return (name[:2] + "…@" + dom) if dom else ""


def status(today: str = None) -> dict:
    """What this installation may do: plan, valid, why, expiry. Never raises."""
    today = today or market_clock.iso(market_clock.now_utc())[:10]
    if public_key() is None:
        return {"configured": False, "plan": "max", "valid": True, "label": "Owner build",
                "reason": "no licence key in this build — nothing is locked"}
    doc = state.read_json(FILE, None)
    if not doc:
        return {"configured": True, "plan": "free", "valid": False, "label": LABEL["free"],
                "reason": "no licence — the simulator is free; a licence unlocks a real broker"}
    try:
        lic = read(doc)
    except ValueError as exc:
        return {"configured": True, "plan": "free", "valid": False, "label": LABEL["free"],
                "reason": "licence refused: %s" % exc}
    out = {"configured": True, "plan": lic["plan"], "valid": True, "label": LABEL[lic["plan"]],
           "expires": lic.get("expires"), "email": _mask(lic.get("email")), "instances": lic.get("instances", 1),
           "id": lic.get("id"), "reason": ""}
    if str(lic.get("expires") or "") < today:
        out.update(plan="free", valid=False, label=LABEL["free"], expired=True,
                   reason="the %s licence ran out on %s — new trades on a real broker stop, open ones keep their "
                          "stops and exits" % (LABEL[lic["plan"]], lic.get("expires")))
    return out


def allows(feature: str, st: dict = None) -> tuple:
    """(True, "") or (False, why) for a feature of NEEDS."""
    st = st or status()
    need = NEEDS[feature]
    if PLANS.index(st["plan"]) >= PLANS.index(need):
        return True, ""
    why = "%s needs the %s plan" % (FEATURE_TEXT[feature], LABEL[need])
    if st.get("reason") and st["plan"] == "free":
        why += " (%s)" % st["reason"]
    return False, why


def install(doc: dict) -> dict:
    """Check a licence and keep it in the state folder; returns its contents. Raises ValueError when it is refused."""
    lic = read(doc)
    state.write_json(FILE, {"licence": doc["licence"], "signature": doc["signature"]})
    try:
        os.chmod(str(state.path(FILE)), 0o600)
    except OSError:
        pass
    return lic
