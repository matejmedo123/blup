"""Solana signing and Jupiter swaps using only the Python standard library.

What lives here:

* base58 (Bitcoin alphabet), the address/signature encoding Solana uses;
* Ed25519 per RFC 8032 in pure Python (with an optional PyNaCl fast path);
* parsing and signing of serialized Solana transactions (legacy and v0),
  which is exactly what the Jupiter Swap API hands back;
* a tiny JSON-RPC client (balance, token balance, send, confirm);
* Jupiter lite API helpers and a one-call ``swap``.

Safety rules this module follows, so callers can rely on them:

* secret material never appears in exception messages, ``repr``/``str``
  output, log records or any HTTP request (only the signed transaction,
  which contains a signature and never the key, is sent anywhere);
* ``sign_tx`` refuses to sign a transaction whose fee payer is not our key,
  so a tampered or mixed-up transaction cannot spend from someone else's
  context with our signature;
* RPC URLs often embed an API key, so they are redacted to scheme://host in
  ``repr`` and never put into error messages.

The pure-Python Ed25519 code is correct but not constant-time. That is an
accepted trade-off for a bot signing its own transactions on its own machine;
if PyNaCl is installed it is used automatically instead.
"""

from __future__ import annotations

import base64
import binascii
import hashlib
import http.client
import json
import logging
import os
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Dict, List, Optional, Sequence, Tuple, Union

log = logging.getLogger(__name__)

try:  # Optional fast path; the pure-Python code below is the reference.
    import nacl.exceptions as _nacl_exceptions  # type: ignore
    import nacl.signing as _nacl_signing  # type: ignore
except Exception:  # pragma: no cover - depends on the environment
    _nacl_signing = None
    _nacl_exceptions = None

# Looked up at call time (not bound into closures) so tests can swap them out.
_urlopen = urllib.request.urlopen
_sleep = time.sleep
_monotonic = time.monotonic

SOL_MINT = "So11111111111111111111111111111111111111112"
USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
SYSTEM_PROGRAM_ID = "11111111111111111111111111111111"
LAMPORTS_PER_SOL = 1_000_000_000

MAINNET_RPC_URL = "https://api.mainnet-beta.solana.com"
JUPITER_QUOTE_URL = "https://lite-api.jup.ag/swap/v1/quote"
JUPITER_SWAP_URL = "https://lite-api.jup.ag/swap/v1/swap"

_USER_AGENT = "solana-stdlib/1.0"


class SolanaError(Exception):
    """An RPC or protocol level failure.

    ``signature`` is set when a transaction may already have been broadcast
    (e.g. the send timed out). Callers must check ``Rpc.confirm(signature)``
    before retrying, otherwise a retry can execute the same trade twice.
    """

    def __init__(
        self,
        message: str,
        code: Optional[int] = None,
        data: Any = None,
        signature: Optional[str] = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.data = data
        self.signature = signature


class TransportError(SolanaError):
    """No usable answer from the server (network error, timeout, HTTP error).

    Distinct from a JSON-RPC error because the outcome is unknown: the server
    may or may not have acted on the request.
    """


class JupiterError(SolanaError):
    """The Jupiter API failed or returned something we refuse to use."""


# ---------------------------------------------------------------------------
# base58
# ---------------------------------------------------------------------------

_B58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
_B58_INDEX = {c: i for i, c in enumerate(_B58_ALPHABET)}


def b58encode(data: bytes) -> str:
    data = bytes(data)
    n = int.from_bytes(data, "big")
    out = []
    while n:
        n, r = divmod(n, 58)
        out.append(_B58_ALPHABET[r])
    # Leading zero bytes carry no numeric value, so base58 spells each as "1".
    zeros = len(data) - len(data.lstrip(b"\0"))
    return "1" * zeros + "".join(reversed(out))


def b58decode(s: Union[str, bytes]) -> bytes:
    if isinstance(s, (bytes, bytearray, memoryview)):
        try:
            text: Optional[str] = bytes(s).decode("ascii")
        except UnicodeDecodeError:
            text = None
        if text is None:
            # Raised outside the except block on purpose: the codec error holds
            # the whole input (possibly a secret key) and "from None" only hides
            # it from printed tracebacks, not from __context__.
            raise ValueError("base58 input is not ASCII")
        s = text
    n = 0
    for i, c in enumerate(s):
        v = _B58_INDEX.get(c)
        if v is None:
            # Position only, never the character: the input may be a secret.
            raise ValueError("invalid base58 character at position %d" % i)
        n = n * 58 + v
    zeros = len(s) - len(s.lstrip("1"))
    return b"\0" * zeros + n.to_bytes((n.bit_length() + 7) // 8, "big")


# ---------------------------------------------------------------------------
# Ed25519 (RFC 8032), pure Python
# ---------------------------------------------------------------------------

_P = 2**255 - 19
_L = 2**252 + 27742317777372353535851937790883648493
_D = -121665 * pow(121666, _P - 2, _P) % _P
_D2 = 2 * _D % _P
_SQRT_M1 = pow(2, (_P - 1) // 4, _P)

# Points are extended homogeneous coordinates (X, Y, Z, T), x=X/Z, y=Y/Z,
# x*y=T/Z: additions then need no field inversion, which dominates cost.
_Point = Tuple[int, int, int, int]
_IDENTITY = (0, 1, 1, 0)


def _inv(x: int) -> int:
    return pow(x, _P - 2, _P)


def _recover_x(y: int, sign: int) -> Optional[int]:
    if y >= _P:
        return None
    x2 = (y * y - 1) * _inv(_D * y * y + 1) % _P
    if x2 == 0:
        return None if sign else 0
    x = pow(x2, (_P + 3) // 8, _P)
    if (x * x - x2) % _P != 0:
        x = x * _SQRT_M1 % _P
    if (x * x - x2) % _P != 0:
        return None
    if (x & 1) != sign:
        x = _P - x
    return x


def _add(p: _Point, q: _Point) -> _Point:
    x1, y1, z1, t1 = p
    x2, y2, z2, t2 = q
    a = (y1 - x1) * (y2 - x2) % _P
    b = (y1 + x1) * (y2 + x2) % _P
    c = t1 * _D2 * t2 % _P
    d = z1 * 2 * z2 % _P
    e, f, g, h = b - a, d - c, d + c, b + a
    return (e * f % _P, g * h % _P, f * g % _P, e * h % _P)


def _double(p: _Point) -> _Point:
    # Dedicated doubling (RFC 8032 5.1.4) is ~25% cheaper than _add(p, p).
    x1, y1, z1, _ = p
    a = x1 * x1 % _P
    b = y1 * y1 % _P
    c = 2 * z1 * z1 % _P
    h = a + b
    e = h - (x1 + y1) * (x1 + y1)
    g = a - b
    f = c + g
    return (e * f % _P, g * h % _P, f * g % _P, e * h % _P)


def _scalarmult(p: _Point, k: int) -> _Point:
    q = _IDENTITY
    while k:
        if k & 1:
            q = _add(q, p)
        p = _double(p)
        k >>= 1
    return q


_GY = 4 * _inv(5) % _P
_GX = _recover_x(_GY, 0)
assert _GX is not None
_G = (_GX, _GY, 1, _GX * _GY % _P)
_BASE_TABLE: List[_Point] = []


def _base_mult(k: int) -> _Point:
    # Every signature needs one or two multiples of the base point, so the
    # 2^i * G table is built once; each multiply is then additions only.
    k %= _L
    if not _BASE_TABLE:
        table = []
        p = _G
        for _ in range(253):  # _L < 2**253
            table.append(p)
            p = _double(p)
        _BASE_TABLE[:] = table
    q = _IDENTITY
    i = 0
    while k:
        if k & 1:
            q = _add(q, _BASE_TABLE[i])
        k >>= 1
        i += 1
    return q


def _point_equal(p: _Point, q: _Point) -> bool:
    return (p[0] * q[2] - q[0] * p[2]) % _P == 0 and (p[1] * q[2] - q[1] * p[2]) % _P == 0


def _compress(p: _Point) -> bytes:
    zi = _inv(p[2])
    x = p[0] * zi % _P
    y = p[1] * zi % _P
    return (y | ((x & 1) << 255)).to_bytes(32, "little")


def _decompress(s: bytes) -> Optional[_Point]:
    if len(s) != 32:
        return None
    y = int.from_bytes(s, "little")
    sign = y >> 255
    y &= (1 << 255) - 1
    x = _recover_x(y, sign)
    if x is None:
        return None
    return (x, y, 1, x * y % _P)


def _hash_int(*parts: bytes) -> int:
    return int.from_bytes(hashlib.sha512(b"".join(parts)).digest(), "little") % _L


def _expand_seed(seed: bytes) -> Tuple[int, bytes]:
    h = hashlib.sha512(seed).digest()
    a = int.from_bytes(h[:32], "little")
    a &= (1 << 254) - 8
    a |= 1 << 254
    return a, h[32:]


def _pubkey_from_seed(seed: bytes) -> bytes:
    if _nacl_signing is not None:
        return bytes(_nacl_signing.SigningKey(seed).verify_key)
    a, _ = _expand_seed(seed)
    return _compress(_base_mult(a))


def _sign_pure(seed: bytes, pub: bytes, msg: bytes) -> bytes:
    a, prefix = _expand_seed(seed)
    r = _hash_int(prefix, msg)
    big_r = _compress(_base_mult(r))
    k = _hash_int(big_r, pub, msg)
    s = (r + k * a) % _L
    return big_r + s.to_bytes(32, "little")


def _verify_pure(pub: bytes, msg: bytes, sig: bytes) -> bool:
    a_point = _decompress(pub)
    if a_point is None:
        return False
    r_point = _decompress(sig[:32])
    if r_point is None:
        return False
    s = int.from_bytes(sig[32:], "little")
    if s >= _L:  # RFC 8032 requires this; otherwise signatures are malleable.
        return False
    k = _hash_int(sig[:32], pub, msg)
    return _point_equal(_base_mult(s), _add(r_point, _scalarmult(a_point, k)))


# ---------------------------------------------------------------------------
# Keys
# ---------------------------------------------------------------------------


def keypair_from_seed(seed: bytes) -> Tuple[bytes, bytes]:
    """Return (secret64, pubkey32); Solana's secret is seed || pubkey."""
    seed = bytes(seed)
    if len(seed) != 32:
        raise ValueError("seed must be 32 bytes, got %d" % len(seed))
    pub = _pubkey_from_seed(seed)
    return seed + pub, pub


def new_keypair() -> Tuple[bytes, bytes]:
    return keypair_from_seed(os.urandom(32))


def _secret_from_ints(values: Sequence[Any]) -> bytes:
    for v in values:
        if not isinstance(v, int) or isinstance(v, bool) or not 0 <= v <= 255:
            raise ValueError("secret key array must contain only integers 0-255")
    return bytes(values)


def _secret_from_text(text: str) -> bytes:
    # Errors are raised outside the except blocks so the underlying exception
    # (json's carries the whole document in .doc) is never chained to ours.
    t = text.strip()
    if t.startswith("["):
        # solana-keygen's file format: a JSON array of 64 byte values.
        try:
            values = json.loads(t)
        except ValueError:
            values = None
        if not isinstance(values, list):
            raise ValueError("secret key is not a valid JSON array")
        return _secret_from_ints(values)
    try:
        raw: Optional[bytes] = b58decode(t)  # Phantom / solana-keygen "base58" export
    except ValueError:
        raw = None
    if raw is None:
        raise ValueError("secret key is not valid base58")
    return raw


def load_keypair(secret: "SecretLike") -> Tuple[bytes, bytes]:
    """Normalize any accepted secret form to (secret64, pubkey32).

    Accepts a ``Keypair``, 64-byte seed||pubkey, a 32-byte seed, base58 of
    either, a JSON array string of 64 ints, or a list/tuple of ints.
    """
    if isinstance(secret, Keypair):
        return secret.secret, secret.pubkey
    if isinstance(secret, str):
        raw = _secret_from_text(secret)
    elif isinstance(secret, (bytes, bytearray, memoryview)):
        raw = bytes(secret)
    elif isinstance(secret, (list, tuple)):
        raw = _secret_from_ints(secret)
    else:
        raise TypeError("unsupported secret key type: %s" % type(secret).__name__)
    if len(raw) not in (32, 64):
        raise ValueError("secret key must be 32 or 64 bytes, got %d" % len(raw))
    seed = raw[:32]
    pub = _pubkey_from_seed(seed)
    # Signing one message under a seed with two different public keys leaks
    # the private scalar, so a stored pubkey half that disagrees with the seed
    # is never trusted, only rejected.
    if len(raw) == 64 and raw[32:] != pub:
        raise ValueError("secret key is corrupt: its public half does not match its seed")
    return seed + pub, pub


def load_keypair_file(path: str) -> "Keypair":
    """Load a solana-keygen JSON file (or a file holding a base58 secret)."""
    with open(path, "r", encoding="utf-8") as fh:
        text = fh.read()
    try:
        return Keypair(text)
    except ValueError as e:
        # Our own messages never contain key material, so they can be reused.
        raise ValueError("%s: %s" % (path, e)) from None


class Keypair:
    """A secret key that cannot end up in logs via repr() or str()."""

    __slots__ = ("_secret", "_pubkey")

    def __init__(self, secret: "SecretLike") -> None:
        self._secret, self._pubkey = load_keypair(secret)

    @classmethod
    def generate(cls) -> "Keypair":
        return cls(new_keypair()[0])

    @property
    def secret(self) -> bytes:
        return self._secret

    @property
    def pubkey(self) -> bytes:
        return self._pubkey

    @property
    def pubkey_b58(self) -> str:
        return b58encode(self._pubkey)

    def sign(self, msg: bytes) -> bytes:
        return sign(self, msg)

    def __repr__(self) -> str:
        return "Keypair(pubkey=%s)" % self.pubkey_b58

    __str__ = __repr__


SecretLike = Union[Keypair, bytes, bytearray, str, Sequence[int]]


def sign(secret: SecretLike, msg: bytes) -> bytes:
    secret64, pub = load_keypair(secret)
    msg = bytes(msg)
    if _nacl_signing is not None:
        return bytes(_nacl_signing.SigningKey(secret64[:32]).sign(msg).signature)
    return _sign_pure(secret64[:32], pub, msg)


def verify(pubkey: Union[bytes, str], msg: bytes, sig: bytes) -> bool:
    """True iff ``sig`` is a valid signature; never raises on bad input."""
    try:
        pub = b58decode(pubkey) if isinstance(pubkey, str) else bytes(pubkey)
        sig = bytes(sig)
        msg = bytes(msg)
    except (TypeError, ValueError):
        return False
    if len(pub) != 32 or len(sig) != 64:
        return False
    if _nacl_signing is not None:
        try:
            _nacl_signing.VerifyKey(pub).verify(msg, sig)
            return True
        except Exception:
            return False
    return _verify_pure(pub, msg, sig)


# ---------------------------------------------------------------------------
# Transactions
# ---------------------------------------------------------------------------

_EMPTY_SIG = bytes(64)


def encode_shortvec(n: int) -> bytes:
    """Solana's compact-u16: 7 bits per byte, high bit = more bytes follow."""
    if not 0 <= n <= 0xFFFF:
        raise ValueError("compact-u16 out of range: %d" % n)
    out = bytearray()
    while True:
        b = n & 0x7F
        n >>= 7
        if n:
            out.append(b | 0x80)
        else:
            out.append(b)
            return bytes(out)


def decode_shortvec(data: bytes, offset: int = 0) -> Tuple[int, int]:
    """Return (value, new_offset). Rejects encodings Solana itself rejects."""
    value = 0
    for i in range(3):
        if offset >= len(data):
            raise ValueError("truncated compact-u16")
        b = data[offset]
        offset += 1
        if i == 2 and b > 0x03:
            raise ValueError("compact-u16 overflows 16 bits")
        value |= (b & 0x7F) << (7 * i)
        if not b & 0x80:
            # A zero high byte means the same number has two encodings; the
            # runtime refuses those, so we do too rather than sign one.
            if i > 0 and b == 0:
                raise ValueError("non-canonical compact-u16")
            return value, offset
    raise ValueError("compact-u16 longer than 3 bytes")


def _take(buf: bytes, offset: int, n: int) -> bytes:
    if offset + n > len(buf):
        raise ValueError("truncated transaction")
    return buf[offset:offset + n]


def _decode_message(msg: bytes) -> Dict[str, Any]:
    if not msg:
        raise ValueError("transaction has no message")
    off = 0
    version: Union[str, int] = "legacy"
    # Legacy messages start with num_required_signatures, which is < 128, so
    # a set high bit unambiguously marks a versioned message.
    if msg[0] & 0x80:
        version = msg[0] & 0x7F
        if version != 0:
            raise ValueError("unsupported transaction version %d" % version)
        off = 1
    hdr = _take(msg, off, 3)
    off += 3
    header = {
        "num_required_signatures": hdr[0],
        "num_readonly_signed": hdr[1],
        "num_readonly_unsigned": hdr[2],
    }
    nkeys, off = decode_shortvec(msg, off)
    keys = []
    for _ in range(nkeys):
        keys.append(_take(msg, off, 32))
        off += 32
    blockhash = _take(msg, off, 32)
    off += 32
    nix, off = decode_shortvec(msg, off)
    instructions = []
    for _ in range(nix):
        program_index = _take(msg, off, 1)[0]
        off += 1
        nacc, off = decode_shortvec(msg, off)
        accounts = list(_take(msg, off, nacc))
        off += nacc
        dlen, off = decode_shortvec(msg, off)
        data = _take(msg, off, dlen)
        off += dlen
        instructions.append({"program_id_index": program_index, "accounts": accounts, "data": data})
    lookups = []
    if version == 0:
        nlookups, off = decode_shortvec(msg, off)
        for _ in range(nlookups):
            table = _take(msg, off, 32)
            off += 32
            nw, off = decode_shortvec(msg, off)
            writable = list(_take(msg, off, nw))
            off += nw
            nr, off = decode_shortvec(msg, off)
            readonly = list(_take(msg, off, nr))
            off += nr
            lookups.append({"account_key": table, "writable_indexes": writable, "readonly_indexes": readonly})
    if off != len(msg):
        raise ValueError("trailing bytes after transaction message")

    # The same sanity rules the runtime applies; a message failing them would
    # be rejected anyway, and signing it could only hide a bug.
    nreq = header["num_required_signatures"]
    if nreq == 0:
        raise ValueError("message requires no signatures (no fee payer)")
    if nreq + header["num_readonly_unsigned"] > nkeys:
        raise ValueError("message header references more accounts than it lists")
    if header["num_readonly_signed"] >= nreq:
        raise ValueError("fee payer would be read-only")
    if len(set(keys)) != len(keys):
        raise ValueError("duplicate account keys in message")
    total = nkeys + sum(len(t["writable_indexes"]) + len(t["readonly_indexes"]) for t in lookups)
    for ix in instructions:
        if ix["program_id_index"] >= total or any(a >= total for a in ix["accounts"]):
            raise ValueError("instruction references an account index out of range")
    return {
        "version": version,
        "header": header,
        "keys": keys,
        "recent_blockhash": blockhash,
        "instructions": instructions,
        "lookups": lookups,
    }


def _decode_tx(raw: bytes) -> Dict[str, Any]:
    if not isinstance(raw, (bytes, bytearray, memoryview)):
        raise TypeError("transaction must be bytes (decode base64 first)")
    raw = bytes(raw)
    nsig, off = decode_shortvec(raw, 0)
    sig_offset = off
    sigs = []
    for _ in range(nsig):
        sigs.append(_take(raw, off, 64))
        off += 64
    message = raw[off:]
    decoded = _decode_message(message)
    nreq = decoded["header"]["num_required_signatures"]
    if nsig != nreq:
        raise ValueError("transaction has %d signature slots but its message requires %d" % (nsig, nreq))
    decoded.update(sig_offset=sig_offset, signatures=sigs, message=message)
    return decoded


def parse_tx(raw: bytes) -> Dict[str, Any]:
    """Decode a serialized transaction (legacy or v0).

    Addresses are returned as base58 strings because that is how they are
    compared against configuration and explorers; signatures and the message
    stay bytes because they feed straight into ``verify``.
    """
    d = _decode_tx(raw)
    return {
        "version": d["version"],
        "signatures": list(d["signatures"]),
        "message": d["message"],
        "header": dict(d["header"]),
        "static_account_keys": [b58encode(k) for k in d["keys"]],
        "recent_blockhash": b58encode(d["recent_blockhash"]),
        "instructions": d["instructions"],
        "address_table_lookups": [
            dict(t, account_key=b58encode(t["account_key"])) for t in d["lookups"]
        ],
    }


def sign_tx(raw: bytes, secret: SecretLike) -> bytes:
    """Sign ``raw`` with ``secret`` and return the new serialized transaction.

    Refuses (ValueError) unless our key is the fee payer: the payer is the
    account the transaction is built around, so a different payer means the
    transaction was not built for us and must not carry our signature.
    """
    secret64, pub = load_keypair(secret)
    d = _decode_tx(raw)
    keys = d["keys"]
    signers = keys[:d["header"]["num_required_signatures"]]
    if keys[0] != pub:
        raise ValueError(
            "refusing to sign: fee payer %s is not our key %s" % (b58encode(keys[0]), b58encode(pub))
        )
    if pub not in signers:  # unreachable while payer == pub; kept as a guard
        raise ValueError("refusing to sign: our key %s is not a required signer" % b58encode(pub))
    slot = signers.index(pub)
    sig = sign(secret64, d["message"])
    out = bytearray(bytes(raw))
    start = d["sig_offset"] + 64 * slot
    out[start:start + 64] = sig
    return bytes(out)


def verify_tx(raw: bytes) -> bool:
    """True iff every required signature is present and valid."""
    try:
        d = _decode_tx(raw)
    except (TypeError, ValueError):
        return False
    for key, sig in zip(d["keys"], d["signatures"]):
        if sig == _EMPTY_SIG or not verify(key, d["message"], sig):
            return False
    return True


def tx_signature(raw_signed: bytes) -> str:
    """The transaction id: base58 of the fee payer's (first) signature."""
    d = _decode_tx(raw_signed)
    if d["signatures"][0] == _EMPTY_SIG:
        raise ValueError("transaction is not signed (first signature slot is empty)")
    return b58encode(d["signatures"][0])


# ---------------------------------------------------------------------------
# HTTP / JSON-RPC
# ---------------------------------------------------------------------------


def _redact_url(url: str) -> str:
    # Providers put API keys in the path or query; only scheme://host is safe.
    parts = urllib.parse.urlsplit(url)
    return "%s://%s" % (parts.scheme, parts.hostname or "?")


def _check_address(value: Union[str, bytes], name: str) -> str:
    if isinstance(value, (bytes, bytearray)):
        value = b58encode(value)
    try:
        ok = isinstance(value, str) and len(b58decode(value)) == 32
    except ValueError:
        ok = False
    if not ok:
        # Never echo the value: a secret pasted into the wrong argument would
        # otherwise end up in the error message.
        raise ValueError("%s is not a valid Solana address" % name)
    return value  # type: ignore[return-value]


def _http(url: str, body: Any, timeout: float) -> Tuple[int, bytes]:
    """Return (status, payload). Raises TransportError when nothing came back."""
    headers = {"Accept": "application/json", "User-Agent": _USER_AGENT}
    data = None
    if body is not None:
        data = json.dumps(body, separators=(",", ":")).encode("utf-8")
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=headers, method="GET" if data is None else "POST")
    try:
        with _urlopen(req, timeout=timeout) as resp:
            return int(getattr(resp, "status", 200) or 200), resp.read()
    except urllib.error.HTTPError as e:
        try:
            payload = e.read()
        except Exception:
            payload = b""
        return int(e.code), payload or b""
    except (urllib.error.URLError, OSError, http.client.HTTPException) as e:
        failure = "%s: %s" % (type(e).__name__, getattr(e, "reason", None) or e)
    # Raised outside the except block: urllib's exception can carry the full
    # URL (API key included) and must not ride along as __context__.
    raise TransportError("network error talking to %s (%s)" % (_redact_url(url), failure.replace(url, "")))


def _json_or_none(payload: bytes) -> Any:
    try:
        return json.loads(payload.decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        return None


def _error_detail(payload: bytes) -> str:
    obj = _json_or_none(payload)
    if isinstance(obj, dict):
        for key in ("error", "message", "errorCode"):
            val = obj.get(key)
            if isinstance(val, str) and val:
                return val
            if isinstance(val, dict) and isinstance(val.get("message"), str):
                return val["message"]
    text = payload.decode("utf-8", "replace").strip()
    return text[:200] if text else "empty response"


def _rpc_error_message(method: str, err: Dict[str, Any]) -> str:
    parts = ["RPC %s error %s: %s" % (method, err.get("code"), err.get("message", "unknown error"))]
    data = err.get("data")
    if isinstance(data, dict):
        if data.get("err") is not None:
            parts.append("err=%s" % json.dumps(data["err"], separators=(",", ":")))
        logs = data.get("logs")
        if isinstance(logs, list) and logs:
            # The tail of the program log is where slippage/balance errors are.
            parts.append("logs: " + " | ".join(str(x) for x in logs[-6:]))
    return "; ".join(parts)


class Rpc:
    """Minimal Solana JSON-RPC client over urllib."""

    def __init__(self, url: str = MAINNET_RPC_URL, timeout: float = 20.0, commitment: str = "confirmed") -> None:
        self.url = url
        self.timeout = timeout
        self.commitment = commitment
        self._next_id = 0

    def __repr__(self) -> str:
        return "Rpc(%s)" % _redact_url(self.url)

    def call(self, method: str, params: Optional[List[Any]] = None) -> Any:
        self._next_id += 1
        body = {"jsonrpc": "2.0", "id": self._next_id, "method": method, "params": params or []}
        status, payload = _http(self.url, body, self.timeout)
        obj = _json_or_none(payload)
        if isinstance(obj, dict) and isinstance(obj.get("error"), dict):
            # A JSON-RPC error is a definite answer, even on a non-200 status.
            err = obj["error"]
            raise SolanaError(_rpc_error_message(method, err), code=err.get("code"), data=err.get("data"))
        if status != 200:
            raise TransportError("RPC %s: HTTP %d: %s" % (method, status, _error_detail(payload)), code=status)
        if not isinstance(obj, dict) or "result" not in obj:
            raise TransportError("RPC %s: malformed response" % method)
        return obj["result"]

    def get_balance(self, pubkey: Union[str, bytes]) -> int:
        """Lamports held by ``pubkey``."""
        addr = _check_address(pubkey, "pubkey")
        res = self.call("getBalance", [addr, {"commitment": self.commitment}])
        try:
            return int(res["value"])
        except (KeyError, TypeError, ValueError):
            raise SolanaError("RPC getBalance: unexpected response shape") from None

    def get_token_balance(self, owner: Union[str, bytes], mint: Union[str, bytes]) -> Tuple[float, int, int]:
        """(ui_amount, raw_amount, decimals) summed over all of owner's accounts for mint.

        Use ``raw_amount`` for arithmetic; ``ui_amount`` is a float for display.
        Native SOL is not an SPL token: for SOL_MINT this reports wrapped SOL
        only, use ``get_balance`` for the native balance.
        """
        owner_s = _check_address(owner, "owner")
        mint_s = _check_address(mint, "mint")
        res = self.call(
            "getTokenAccountsByOwner",
            [owner_s, {"mint": mint_s}, {"encoding": "jsonParsed", "commitment": self.commitment}],
        )
        raw = 0
        decimals = None
        try:
            for item in res["value"]:
                amount = item["account"]["data"]["parsed"]["info"]["tokenAmount"]
                raw += int(amount["amount"])
                decimals = int(amount["decimals"])
            if decimals is None:
                # No token account yet: the balance is zero, but callers still
                # need the decimals to size orders.
                supply = self.call("getTokenSupply", [mint_s, {"commitment": self.commitment}])
                decimals = int(supply["value"]["decimals"])
        except (KeyError, TypeError, ValueError):
            raise SolanaError("RPC getTokenAccountsByOwner: unexpected response shape") from None
        return raw / (10 ** decimals), raw, decimals

    def send_raw(self, raw: bytes, skip_preflight: bool = False, max_retries: Optional[int] = 3) -> str:
        """Broadcast a signed transaction; returns its signature.

        On TransportError the transaction may have been broadcast anyway, so
        the error carries ``signature`` for the caller to ``confirm``.
        """
        expected = tx_signature(raw)  # also refuses an unsigned transaction
        config: Dict[str, Any] = {
            "encoding": "base64",
            "skipPreflight": bool(skip_preflight),
            "preflightCommitment": self.commitment,
        }
        if max_retries is not None:
            config["maxRetries"] = int(max_retries)
        encoded = base64.b64encode(bytes(raw)).decode("ascii")
        try:
            sig = self.call("sendTransaction", [encoded, config])
        except TransportError as e:
            e.signature = expected
            raise
        if sig != expected:
            raise SolanaError(
                "RPC sendTransaction returned signature %s, expected %s" % (sig, expected), signature=expected
            )
        return sig

    def confirm(self, signature: str, timeout_s: float = 60.0, poll_s: float = 2.0) -> str:
        """Poll until confirmed/finalized/failed; returns one of
        "confirmed", "finalized", "failed: <err json>" or "timeout"."""
        deadline = _monotonic() + timeout_s
        while True:
            try:
                res = self.call("getSignatureStatuses", [[signature], {"searchTransactionHistory": False}])
                value = res.get("value") if isinstance(res, dict) else None
                status = value[0] if isinstance(value, list) and value else None
                if isinstance(status, dict):
                    if status.get("err") is not None:
                        return "failed: %s" % json.dumps(status["err"], separators=(",", ":"))
                    level = status.get("confirmationStatus")
                    if level in ("confirmed", "finalized"):
                        return level
                    if level is None and status.get("confirmations") is None:
                        return "finalized"  # older nodes: null confirmations == rooted
            except SolanaError as e:
                # A flaky poll says nothing about the transaction; giving up
                # early would invite a retry that double-executes the trade.
                log.debug("confirm %s: poll failed: %s", signature, e)
            remaining = deadline - _monotonic()
            if remaining <= 0:
                return "timeout"
            _sleep(min(poll_s, remaining))


# ---------------------------------------------------------------------------
# Jupiter (lite API, no key)
# ---------------------------------------------------------------------------


def jupiter_quote(
    input_mint: str, output_mint: str, amount_raw: int, slippage_bps: int, timeout: float = 15.0
) -> Dict[str, Any]:
    """ExactIn quote for ``amount_raw`` base units of ``input_mint``."""
    input_mint = _check_address(input_mint, "input_mint")
    output_mint = _check_address(output_mint, "output_mint")
    if input_mint == output_mint:
        raise ValueError("input_mint and output_mint are the same")
    if not isinstance(amount_raw, int) or isinstance(amount_raw, bool) or amount_raw <= 0:
        raise ValueError("amount_raw must be a positive integer of base units")
    if not isinstance(slippage_bps, int) or isinstance(slippage_bps, bool) or not 0 <= slippage_bps <= 10_000:
        raise ValueError("slippage_bps must be an integer between 0 and 10000")
    query = urllib.parse.urlencode(
        {"inputMint": input_mint, "outputMint": output_mint, "amount": str(amount_raw), "slippageBps": str(slippage_bps)}
    )
    try:
        status, payload = _http(JUPITER_QUOTE_URL + "?" + query, None, timeout)
    except TransportError as e:
        raise JupiterError("Jupiter quote: %s" % e) from None
    if status != 200:
        raise JupiterError("Jupiter quote: HTTP %d: %s" % (status, _error_detail(payload)), code=status)
    quote = _json_or_none(payload)
    if not isinstance(quote, dict) or quote.get("error"):
        raise JupiterError("Jupiter quote: %s" % _error_detail(payload))
    # Signing a swap for a quote that is not what we asked for (wrong pair or
    # size) would execute the wrong trade, so the echo is checked.
    if (
        quote.get("inputMint") != input_mint
        or quote.get("outputMint") != output_mint
        or str(quote.get("inAmount")) != str(amount_raw)
    ):
        raise JupiterError("Jupiter quote does not match the request (mints or inAmount differ)")
    return quote


def jupiter_swap_tx(
    quote: Dict[str, Any],
    user_pubkey_b58: Union[str, bytes],
    priority_lamports: Union[int, str, Dict[str, Any], None] = None,
    timeout: float = 20.0,
) -> bytes:
    """Ask Jupiter to build the swap transaction for ``quote``; returns raw bytes.

    ``priority_lamports``: None leaves Jupiter's default ("auto"); an int is a
    fixed priority fee in lamports; a dict (e.g. ``{"priorityLevelWithMaxLamports":
    {"maxLamports": 1_000_000, "priorityLevel": "high"}}``) or "auto" is passed through.
    """
    user = _check_address(user_pubkey_b58, "user_pubkey_b58")
    body: Dict[str, Any] = {
        "quoteResponse": quote,
        "userPublicKey": user,
        "wrapAndUnwrapSol": True,
        "dynamicComputeUnitLimit": True,
    }
    if priority_lamports is not None:
        if isinstance(priority_lamports, bool):
            raise ValueError("priority_lamports must be an int, 'auto' or a dict")
        if isinstance(priority_lamports, int):
            if priority_lamports < 0:
                raise ValueError("priority_lamports must not be negative")
        elif not (priority_lamports == "auto" or isinstance(priority_lamports, dict)):
            raise ValueError("priority_lamports must be an int, 'auto' or a dict")
        body["prioritizationFeeLamports"] = priority_lamports
    try:
        status, payload = _http(JUPITER_SWAP_URL, body, timeout)
    except TransportError as e:
        raise JupiterError("Jupiter swap: %s" % e) from None
    if status != 200:
        raise JupiterError("Jupiter swap: HTTP %d: %s" % (status, _error_detail(payload)), code=status)
    resp = _json_or_none(payload)
    if not isinstance(resp, dict):
        raise JupiterError("Jupiter swap: malformed response")
    if resp.get("simulationError"):
        # Jupiter already simulated it (for the compute limit) and it failed;
        # sending would only burn the fee.
        raise JupiterError("Jupiter swap simulation failed: %s" % json.dumps(resp["simulationError"])[:300])
    encoded = resp.get("swapTransaction")
    if not isinstance(encoded, str) or not encoded:
        raise JupiterError("Jupiter swap: response has no swapTransaction (%s)" % _error_detail(payload))
    try:
        raw = base64.b64decode(encoded, validate=True)
        d = _decode_tx(raw)
    except (binascii.Error, ValueError) as e:
        raise JupiterError("Jupiter swap: undecodable swapTransaction (%s)" % e) from None
    if b58encode(d["keys"][0]) != user:
        raise JupiterError("Jupiter swap: transaction fee payer is not %s" % user)
    return raw


def swap(
    rpc: Rpc,
    secret: SecretLike,
    input_mint: str,
    output_mint: str,
    amount_raw: int,
    slippage_bps: int,
    priority_lamports: Union[int, str, Dict[str, Any], None] = None,
    confirm_timeout_s: float = 60.0,
) -> Dict[str, Any]:
    """quote -> build -> sign -> verify -> send -> confirm.

    Returns {"signature", "status", "quote"}; ``status`` is whatever
    ``Rpc.confirm`` returned, so check it for "failed: ..." / "timeout".
    A TransportError from the send carries ``signature``: confirm it before
    retrying, because the swap may already have executed.
    """
    kp = secret if isinstance(secret, Keypair) else Keypair(secret)
    quote = jupiter_quote(input_mint, output_mint, amount_raw, slippage_bps)
    raw = jupiter_swap_tx(quote, kp.pubkey_b58, priority_lamports)
    signed = sign_tx(raw, kp)
    if not verify_tx(signed):
        # Catches a transaction that needs another signer, or a signing bug,
        # before anything leaves the machine.
        raise SolanaError("refusing to send: signed transaction does not verify (missing or invalid signature)")
    signature = tx_signature(signed)
    log.info(
        "swap %s -> %s in=%s out~%s sending %s",
        input_mint, output_mint, quote.get("inAmount"), quote.get("outAmount"), signature,
    )
    rpc.send_raw(signed)
    status = rpc.confirm(signature, timeout_s=confirm_timeout_s)
    log.info("swap %s status %s", signature, status)
    return {"signature": signature, "status": status, "quote": quote}
