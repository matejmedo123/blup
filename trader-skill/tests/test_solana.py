"""Offline tests for the Solana signing / Jupiter swap module.

Every HTTP call goes through a fake ``_urlopen``; nothing touches the network.
"""

from __future__ import annotations

import base64
import hashlib
import io
import json
import logging
import os
import random
import socket
import struct
import tempfile
import time
import traceback
import unittest
import urllib.error
import urllib.parse
from unittest import mock

try:  # inside the repo the module lives at shared/solana.py
    from shared import solana
except ImportError:  # standalone: solana.py sits next to this file
    import solana

HERE = os.path.dirname(os.path.abspath(__file__))
FIXTURES = os.path.join(HERE, "fixtures")


def load_fixture(name):
    with open(os.path.join(FIXTURES, name), encoding="utf-8") as fh:
        return json.load(fh)


_saved_nacl = None


def setUpModule():
    # Pure Python is the path that must always work, so it is the one under
    # test even when PyNaCl happens to be installed.
    global _saved_nacl
    _saved_nacl = solana._nacl_signing
    solana._nacl_signing = None


def tearDownModule():
    solana._nacl_signing = _saved_nacl


def key(label):
    return hashlib.sha256(b"test-key:" + label.encode()).digest()


SEED = hashlib.sha256(b"solana-mod test wallet").digest()
SECRET64, PUB = solana.keypair_from_seed(SEED)
PUB_B58 = solana.b58encode(PUB)
OTHER_SECRET, OTHER_PUB = solana.keypair_from_seed(hashlib.sha256(b"someone else").digest())

COMPUTE_BUDGET = solana.b58decode("ComputeBudget111111111111111111111111111111")
JUPITER_PROGRAM = solana.b58decode("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4")
SYSTEM_PROGRAM = bytes(32)


# --- hand-built transactions ------------------------------------------------


def sv(n):
    return solana.encode_shortvec(n)


def build_message(version, header, keys, blockhash, instructions, lookups=()):
    out = bytearray()
    if version == 0:
        out.append(0x80)
    out += bytes(header)
    out += sv(len(keys))
    for k in keys:
        out += k
    out += blockhash
    out += sv(len(instructions))
    for program_index, accounts, data in instructions:
        out.append(program_index)
        out += sv(len(accounts)) + bytes(accounts)
        out += sv(len(data)) + data
    if version == 0:
        out += sv(len(lookups))
        for table, writable, readonly in lookups:
            out += table + sv(len(writable)) + bytes(writable) + sv(len(readonly)) + bytes(readonly)
    return bytes(out)


def unsigned_tx(message, num_signatures=1):
    return sv(num_signatures) + bytes(64 * num_signatures) + message


def legacy_transfer_message(payer=PUB, to=None, lamports=1000):
    to = to or key("recipient")
    data = struct.pack("<IQ", 2, lamports)  # SystemInstruction::Transfer
    return build_message("legacy", (1, 0, 1), [payer, to, SYSTEM_PROGRAM], key("blockhash"), [(2, [0, 1], data)])


def v0_swap_message(payer=PUB):
    # Shaped like a Jupiter swap: compute budget + a router call that also
    # touches accounts loaded from an address lookup table (indexes 4..6).
    keys = [payer, key("user-usdc-ata"), COMPUTE_BUDGET, JUPITER_PROGRAM]
    instructions = [
        (2, [], b"\x02" + struct.pack("<I", 200000)),
        (3, [0, 1, 4, 5, 6], b"\xe5\x17\xcb\x97" + key("route-data")[:20]),
    ]
    lookups = [(key("lookup-table"), [7, 9], [3])]
    return build_message(0, (1, 0, 2), keys, key("blockhash"), instructions, lookups)


# --- fake HTTP ----------------------------------------------------------------


class FakeResponse:
    def __init__(self, payload, status=200):
        self._payload = payload
        self.status = status

    def read(self):
        return self._payload

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


class FakeHTTP:
    """Stands in for urlopen: records each request, answers from a script.

    ``script`` is a list of replies consumed in order, or a callable taking
    the recorded request. A reply is a JSON-able object, a FakeResponse, or
    an exception instance to raise.
    """

    def __init__(self, script):
        self.script = script
        self.requests = []

    def __call__(self, req, timeout=None):
        body = req.data
        rec = {
            "url": req.full_url,
            "method": req.get_method(),
            "headers": dict(req.header_items()),
            "body": body,
            "json": json.loads(body.decode()) if body else None,
            "timeout": timeout,
        }
        self.requests.append(rec)
        reply = self.script(rec) if callable(self.script) else self.script.pop(0)
        if isinstance(reply, BaseException):
            raise reply
        if isinstance(reply, FakeResponse):
            return reply
        return FakeResponse(json.dumps(reply).encode())


def http_error(url, code, body):
    return urllib.error.HTTPError(url, code, "error", {}, io.BytesIO(body.encode()))


def rpc_ok(result):
    return {"jsonrpc": "2.0", "id": 1, "result": result}


def rpc_err(code, message, data=None):
    err = {"code": code, "message": message}
    if data is not None:
        err["data"] = data
    return {"jsonrpc": "2.0", "id": 1, "error": err}


def status_reply(status):
    return rpc_ok({"context": {"slot": 1}, "value": [status]})


class FakeClock:
    def __init__(self):
        self.now = 1000.0
        self.sleeps = []

    def monotonic(self):
        return self.now

    def sleep(self, seconds):
        self.sleeps.append(seconds)
        self.now += seconds


# --- secret leak detection ------------------------------------------------------


def _secret_forms():
    seed = SEED
    forms = [
        seed.hex(),
        seed.hex().upper(),
        solana.b58encode(seed),
        base64.b64encode(seed).decode(),
        base64.urlsafe_b64encode(seed).decode(),
        json.dumps(list(seed)),
        str(list(seed)),
        repr(seed)[2:-1],
        # The 64-byte encodings mix in the public half, but base58 is a
        # function of every byte and base64's first 40 chars cover the seed.
        solana.b58encode(SECRET64),
        base64.b64encode(SECRET64).decode()[:40],
    ]
    return forms


SECRET_FORMS = _secret_forms()
WINDOW = 12


def leaked(text):
    """Return the first secret fragment found in ``text``, else None.

    Any 12-char window counts, so partial leaks are caught too.
    """
    for form in SECRET_FORMS:
        for i in range(len(form) - WINDOW + 1):
            if form[i:i + WINDOW] in text:
                return form[i:i + WINDOW]
    return None


def leaked_bytes(blob):
    for i in range(len(SEED) - 8 + 1):
        if SEED[i:i + 8] in blob:
            return True
    return False


# =============================================================================


class Base58Tests(unittest.TestCase):
    # From Bitcoin Core's base58_encode_decode.json.
    VECTORS = [
        ("", ""),
        ("61", "2g"),
        ("626262", "a3gV"),
        ("636363", "aPEr"),
        ("73696d706c792061206c6f6e6720737472696e67", "2cFupjhnEsSn59qHXstmK2ffpLv2"),
        ("00eb15231dfceb60925886b67d065299925915aeb172c06647", "1NS17iag9jJgTHD1VXjvLCEnZuQ3rJDE9L"),
        ("516b6fcd0f", "ABnLTmg"),
        ("bf4f89001e670274dd", "3SEo3LWLoPntC"),
        ("572e4794", "3EFU7m"),
        ("ecac89cad93923c02321", "EJDM8drfXA6uyA"),
        ("10c8511e", "Rt5zm"),
        ("00000000000000000000", "1111111111"),
    ]

    def test_known_vectors(self):
        for hexdata, text in self.VECTORS:
            with self.subTest(text=text):
                self.assertEqual(solana.b58encode(bytes.fromhex(hexdata)), text)
                self.assertEqual(solana.b58decode(text), bytes.fromhex(hexdata))

    def test_system_program_is_32_zero_bytes(self):
        self.assertEqual(solana.b58decode(solana.SYSTEM_PROGRAM_ID), bytes(32))
        self.assertEqual(solana.b58encode(bytes(32)), "11111111111111111111111111111111")

    def test_well_known_addresses(self):
        sol = solana.b58decode(solana.SOL_MINT)
        self.assertEqual(sol.hex(), "069b8857feab8184fb687f634618c035dac439dc1aeb3b5598a0f00000000001")
        token_program = solana.b58decode("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA")
        self.assertEqual(token_program.hex(), "06ddf6e1d765a193d9cbe146ceeb79ac1cb485ed5f5b37913a8cf5857eff00a9")
        for addr in (solana.SOL_MINT, solana.USDC_MINT):
            self.assertEqual(len(solana.b58decode(addr)), 32)
            self.assertEqual(solana.b58encode(solana.b58decode(addr)), addr)

    def test_leading_zeros_round_trip(self):
        rng = random.Random(7)
        for zeros in range(6):
            for tail_len in (0, 1, 5, 31, 64):
                data = bytes(zeros) + bytes(rng.randrange(1, 256) for _ in range(tail_len))
                text = solana.b58encode(data)
                self.assertTrue(text.startswith("1" * zeros))
                self.assertEqual(solana.b58decode(text), data)

    def test_random_round_trip(self):
        rng = random.Random(1234)
        for _ in range(300):
            data = bytes(rng.randrange(256) for _ in range(rng.randrange(0, 70)))
            self.assertEqual(solana.b58decode(solana.b58encode(data)), data)

    def test_rejects_characters_outside_alphabet(self):
        for bad in ("0", "O", "I", "l", "+", "abc def", "é"):
            with self.subTest(bad=bad):
                with self.assertRaises(ValueError):
                    solana.b58decode(bad)

    def test_accepts_ascii_bytes(self):
        self.assertEqual(solana.b58decode(b"2g"), b"a")
        with self.assertRaises(ValueError):
            solana.b58decode(b"\xff\xfe")


class Ed25519Tests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.vectors = load_fixture("rfc8032_ed25519.json")["vectors"]

    def test_fixture_has_required_rfc_vectors(self):
        names = {v["name"] for v in self.vectors}
        self.assertTrue({"TEST 1", "TEST 2", "TEST 3", "TEST 1024"} <= names)

    def test_rfc8032_vectors(self):
        for v in self.vectors:
            with self.subTest(v["name"]):
                seed = bytes.fromhex(v["secret_key"])
                pub = bytes.fromhex(v["public_key"])
                msg = bytes.fromhex(v["message"])
                sig = bytes.fromhex(v["signature"])
                secret64, derived = solana.keypair_from_seed(seed)
                self.assertEqual(derived, pub)
                self.assertEqual(secret64, seed + pub)
                self.assertEqual(solana.sign(seed, msg), sig)
                self.assertEqual(solana.sign(secret64, msg), sig)
                self.assertTrue(solana.verify(pub, msg, sig))
                self.assertTrue(solana.verify(solana.b58encode(pub), msg, sig))

    def test_verify_rejects_tampering(self):
        v = next(x for x in self.vectors if x["name"] == "TEST 3")
        pub = bytes.fromhex(v["public_key"])
        msg = bytes.fromhex(v["message"])
        sig = bytes.fromhex(v["signature"])
        self.assertFalse(solana.verify(pub, msg + b"\x00", sig))
        self.assertFalse(solana.verify(pub, msg, sig[:-1] + bytes([sig[-1] ^ 1])))
        self.assertFalse(solana.verify(pub, msg, bytes([sig[0] ^ 1]) + sig[1:]))
        self.assertFalse(solana.verify(OTHER_PUB, msg, sig))

    def test_verify_rejects_non_canonical_s(self):
        # s + L verifies algebraically; RFC 8032 requires rejecting it so a
        # signature cannot be altered into a second valid one.
        v = self.vectors[0]
        pub = bytes.fromhex(v["public_key"])
        sig = bytes.fromhex(v["signature"])
        s = int.from_bytes(sig[32:], "little") + solana._L
        self.assertFalse(solana.verify(pub, b"", sig[:32] + s.to_bytes(32, "little")))

    def test_verify_never_raises_on_garbage(self):
        self.assertFalse(solana.verify(b"short", b"m", bytes(64)))
        self.assertFalse(solana.verify(PUB, b"m", b"short"))
        self.assertFalse(solana.verify("not base58 0OIl", b"m", bytes(64)))
        self.assertFalse(solana.verify(PUB, b"m", bytes(64)))
        self.assertFalse(solana.verify(b"\xff" * 32, b"m", bytes(64)))

    def test_new_keypair(self):
        s1, p1 = solana.new_keypair()
        s2, p2 = solana.new_keypair()
        self.assertNotEqual(s1, s2)
        self.assertEqual((len(s1), len(p1)), (64, 32))
        self.assertEqual(s1[32:], p1)
        sig = solana.sign(s1, b"hello")
        self.assertTrue(solana.verify(p1, b"hello", sig))
        self.assertFalse(solana.verify(p2, b"hello", sig))

    def test_pure_python_signing_is_fast_enough(self):
        msg = b"x" * 300  # about the size of a swap message
        start = time.perf_counter()
        for _ in range(5):
            sig = solana.sign(SECRET64, msg)
        per_sign = (time.perf_counter() - start) / 5
        start = time.perf_counter()
        self.assertTrue(solana.verify(PUB, msg, sig))
        per_verify = time.perf_counter() - start
        self.assertLess(per_sign, 1.0)
        self.assertLess(per_verify, 1.0)

    @unittest.skipIf(_saved_nacl is None and solana._nacl_signing is None, "PyNaCl not installed")
    def test_nacl_fast_path_agrees(self):  # pragma: no cover - optional dependency
        msg = b"cross-check"
        pure = solana.sign(SECRET64, msg)
        solana._nacl_signing = _saved_nacl
        try:
            self.assertEqual(solana.sign(SECRET64, msg), pure)
            self.assertTrue(solana.verify(PUB, msg, pure))
        finally:
            solana._nacl_signing = None


class KeyFormatTests(unittest.TestCase):
    def test_all_supported_forms_load_the_same_key(self):
        forms = {
            "64 bytes": SECRET64,
            "bytearray": bytearray(SECRET64),
            "32-byte seed": SEED,
            "base58 of 64": solana.b58encode(SECRET64),
            "base58 with whitespace": "  " + solana.b58encode(SECRET64) + "\n",
            "base58 of seed": solana.b58encode(SEED),
            "json array text": json.dumps(list(SECRET64)),
            "json array pretty": "[\n" + ",\n".join(str(b) for b in SECRET64) + "\n]\n",
            "list of ints": list(SECRET64),
            "tuple of ints": tuple(SECRET64),
            "Keypair": solana.Keypair(SECRET64),
        }
        for name, value in forms.items():
            with self.subTest(name):
                self.assertEqual(solana.load_keypair(value), (SECRET64, PUB))

    def test_keypair_file(self):
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "id.json")
            with open(path, "w") as fh:
                json.dump(list(SECRET64), fh)
            kp = solana.load_keypair_file(path)
            self.assertEqual(kp.pubkey, PUB)
            self.assertEqual(kp.pubkey_b58, PUB_B58)
            self.assertEqual(kp.secret, SECRET64)

    def test_sign_accepts_every_form(self):
        expected = solana.sign(SECRET64, b"m")
        for value in (SEED, solana.b58encode(SECRET64), json.dumps(list(SECRET64)), solana.Keypair(SEED)):
            self.assertEqual(solana.sign(value, b"m"), expected)

    def test_rejects_bad_forms(self):
        bad = [
            SECRET64[:63],
            json.dumps(list(SECRET64)[:63]),
            json.dumps(list(SECRET64)[:-1] + [256]),
            json.dumps(list(SECRET64)[:-1] + [True]),
            "[1, 2, ",
            '{"a": 1}',
            solana.b58encode(SECRET64)[:-5],
            "",
        ]
        for value in bad:
            with self.assertRaises(ValueError):
                solana.load_keypair(value)
        with self.assertRaises(TypeError):
            solana.load_keypair(12345)

    def test_rejects_mismatched_public_half(self):
        with self.assertRaises(ValueError) as cm:
            solana.load_keypair(SEED + OTHER_PUB)
        self.assertIn("does not match", str(cm.exception))

    def test_keypair_never_prints_secret(self):
        kp = solana.Keypair(SECRET64)
        for text in (repr(kp), str(kp), "%s" % kp, "{}".format(kp), repr([kp]), repr({"k": kp})):
            self.assertIsNone(leaked(text), text)
            self.assertIn(PUB_B58, text)


class ShortvecTests(unittest.TestCase):
    VECTORS = [
        (0, "00"), (1, "01"), (127, "7f"), (128, "8001"), (255, "ff01"),
        (16383, "ff7f"), (16384, "808001"), (65535, "ffff03"),
    ]

    def test_vectors(self):
        for n, hexdata in self.VECTORS:
            self.assertEqual(solana.encode_shortvec(n).hex(), hexdata)
            self.assertEqual(solana.decode_shortvec(bytes.fromhex(hexdata) + b"\xaa"), (n, len(hexdata) // 2))

    def test_rejects_invalid(self):
        for hexdata in ("", "80", "8000", "ff8000", "ffff04", "ffff83", "80808001"):
            with self.subTest(hexdata):
                with self.assertRaises(ValueError):
                    solana.decode_shortvec(bytes.fromhex(hexdata))
        for n in (-1, 65536):
            with self.assertRaises(ValueError):
                solana.encode_shortvec(n)


class TransactionTests(unittest.TestCase):
    def _sign_and_check(self, message, version):
        raw = unsigned_tx(message)
        parsed = solana.parse_tx(raw)
        self.assertEqual(parsed["version"], version)
        self.assertEqual(parsed["signatures"], [bytes(64)])
        self.assertEqual(parsed["message"], message)
        self.assertEqual(parsed["static_account_keys"][0], PUB_B58)
        self.assertEqual(parsed["recent_blockhash"], solana.b58encode(key("blockhash")))

        signed = solana.sign_tx(raw, SECRET64)
        self.assertEqual(len(signed), len(raw))
        self.assertEqual(signed[:1], raw[:1])
        self.assertEqual(signed[65:], raw[65:], "the message must not change")

        back = solana.parse_tx(signed)
        sig = back["signatures"][0]
        self.assertEqual(signed[1:65], sig, "our signature sits in slot 0")
        self.assertNotEqual(sig, bytes(64))
        self.assertEqual(back["message"], message)
        self.assertTrue(solana.verify(PUB, back["message"], sig))
        self.assertTrue(solana.verify_tx(signed))
        self.assertFalse(solana.verify_tx(raw))
        self.assertEqual(solana.tx_signature(signed), solana.b58encode(sig))
        # Ed25519 is deterministic, so re-signing must be a no-op.
        self.assertEqual(solana.sign_tx(signed, SECRET64), signed)
        return back

    def test_legacy_transaction(self):
        message = legacy_transfer_message()
        self.assertLess(message[0], 0x80)
        back = self._sign_and_check(message, "legacy")
        self.assertEqual(
            back["header"],
            {"num_required_signatures": 1, "num_readonly_signed": 0, "num_readonly_unsigned": 1},
        )
        self.assertEqual(len(back["static_account_keys"]), 3)
        self.assertEqual(back["static_account_keys"][2], solana.SYSTEM_PROGRAM_ID)
        self.assertEqual(back["instructions"][0]["program_id_index"], 2)
        self.assertEqual(back["instructions"][0]["accounts"], [0, 1])
        self.assertEqual(back["instructions"][0]["data"], struct.pack("<IQ", 2, 1000))
        self.assertEqual(back["address_table_lookups"], [])

    def test_v0_transaction(self):
        message = v0_swap_message()
        self.assertEqual(message[0], 0x80, "v0 messages start with the version prefix")
        back = self._sign_and_check(message, 0)
        self.assertEqual(back["header"]["num_readonly_unsigned"], 2)
        self.assertEqual(back["static_account_keys"][3], "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4")
        self.assertEqual(
            back["address_table_lookups"],
            [{"account_key": solana.b58encode(key("lookup-table")), "writable_indexes": [7, 9], "readonly_indexes": [3]}],
        )
        self.assertEqual(len(back["instructions"]), 2)

    def test_signature_covers_version_prefix(self):
        # Signing the message without the 0x80 byte would yield a signature
        # the network rejects; make sure the prefix is part of what we sign.
        message = v0_swap_message()
        signed = solana.sign_tx(unsigned_tx(message), SECRET64)
        sig = solana.parse_tx(signed)["signatures"][0]
        self.assertTrue(solana.verify(PUB, message, sig))
        self.assertFalse(solana.verify(PUB, message[1:], sig))

    def test_accepts_every_secret_form(self):
        raw = unsigned_tx(v0_swap_message())
        expected = solana.sign_tx(raw, SECRET64)
        for secret in (SEED, solana.b58encode(SECRET64), json.dumps(list(SECRET64)), solana.Keypair(SECRET64)):
            self.assertEqual(solana.sign_tx(raw, secret), expected)

    def test_refuses_when_fee_payer_is_not_us(self):
        raw = unsigned_tx(v0_swap_message(payer=OTHER_PUB))
        with self.assertRaises(ValueError) as cm:
            solana.sign_tx(raw, SECRET64)
        text = str(cm.exception)
        self.assertIn("fee payer", text)
        self.assertIn(solana.b58encode(OTHER_PUB), text)
        self.assertIsNone(leaked(text))

    def test_refuses_when_we_are_not_a_signer(self):
        keys = [OTHER_PUB, PUB, SYSTEM_PROGRAM]  # our key is a plain account
        message = build_message("legacy", (1, 0, 1), keys, key("blockhash"), [(2, [0, 1], b"\x00")])
        with self.assertRaises(ValueError):
            solana.sign_tx(unsigned_tx(message), SECRET64)

    def test_refuses_as_cosigner_but_not_payer(self):
        keys = [OTHER_PUB, PUB, SYSTEM_PROGRAM]
        message = build_message("legacy", (2, 1, 1), keys, key("blockhash"), [(2, [0, 1], b"\x00")])
        with self.assertRaises(ValueError):
            solana.sign_tx(unsigned_tx(message, 2), SECRET64)

    def test_partial_signing_leaves_other_slots(self):
        keys = [PUB, OTHER_PUB, SYSTEM_PROGRAM]
        message = build_message("legacy", (2, 1, 1), keys, key("blockhash"), [(2, [0, 1], b"\x00")])
        signed = solana.sign_tx(unsigned_tx(message, 2), SECRET64)
        sigs = solana.parse_tx(signed)["signatures"]
        self.assertTrue(solana.verify(PUB, message, sigs[0]))
        self.assertEqual(sigs[1], bytes(64))
        self.assertFalse(solana.verify_tx(signed), "a missing cosigner must fail verification")

    def test_rejects_malformed(self):
        message = v0_swap_message()
        raw = unsigned_tx(message)
        cases = {
            "truncated": raw[:-1],
            "trailing bytes": raw + b"\x00",
            "slot count mismatch": unsigned_tx(message, 2),
            "unsupported version": unsigned_tx(b"\x81" + message[1:]),
            "non-canonical count": b"\x81\x00" + raw[1:],
            "no signatures required": unsigned_tx(
                build_message("legacy", (0, 0, 0), [PUB], key("blockhash"), []), 0
            ),
            "duplicate keys": unsigned_tx(
                build_message("legacy", (1, 0, 0), [PUB, PUB], key("blockhash"), [])
            ),
            "index out of range": unsigned_tx(
                build_message("legacy", (1, 0, 1), [PUB, SYSTEM_PROGRAM], key("blockhash"), [(5, [0], b"")])
            ),
            "empty": b"",
        }
        for name, blob in cases.items():
            with self.subTest(name):
                with self.assertRaises(ValueError):
                    solana.parse_tx(blob)
                with self.assertRaises(ValueError):
                    solana.sign_tx(blob, SECRET64)
                self.assertFalse(solana.verify_tx(blob))
        with self.assertRaises(TypeError):
            solana.parse_tx(base64.b64encode(raw).decode())

    def test_tx_signature_requires_signed_tx(self):
        with self.assertRaises(ValueError):
            solana.tx_signature(unsigned_tx(legacy_transfer_message()))


class RpcTests(unittest.TestCase):
    def setUp(self):
        self.rpc = solana.Rpc("https://rpc.example.com", timeout=7.5)

    def run_with(self, script, fn):
        fake = FakeHTTP(script)
        with mock.patch.object(solana, "_urlopen", fake):
            return fn(), fake

    def test_get_balance(self):
        result, fake = self.run_with(
            [rpc_ok({"context": {"slot": 5}, "value": 1234})],
            lambda: self.rpc.get_balance(solana.SYSTEM_PROGRAM_ID),
        )
        self.assertEqual(result, 1234)
        req = fake.requests[0]
        self.assertEqual(req["method"], "POST")
        self.assertEqual(req["url"], "https://rpc.example.com")
        self.assertEqual(req["timeout"], 7.5)
        self.assertEqual(req["headers"].get("Content-type"), "application/json")
        self.assertEqual(req["json"]["jsonrpc"], "2.0")
        self.assertEqual(req["json"]["method"], "getBalance")
        self.assertEqual(req["json"]["params"][0], solana.SYSTEM_PROGRAM_ID)

    def test_bad_address_is_rejected_before_any_request(self):
        fake = FakeHTTP([])
        with mock.patch.object(solana, "_urlopen", fake):
            for bad in ("not-an-address", solana.b58encode(SECRET64), ""):
                with self.assertRaises(ValueError) as cm:
                    self.rpc.get_balance(bad)
                self.assertIsNone(leaked(str(cm.exception)))
        self.assertEqual(fake.requests, [])

    def test_get_token_balance_sums_accounts(self):
        def account(amount):
            info = {"tokenAmount": {"amount": amount, "decimals": 6, "uiAmount": None}}
            return {"pubkey": "x", "account": {"data": {"parsed": {"info": info}}}}

        result, fake = self.run_with(
            [rpc_ok({"context": {"slot": 1}, "value": [account("1500000"), account("250000")]})],
            lambda: self.rpc.get_token_balance(PUB_B58, solana.USDC_MINT),
        )
        self.assertEqual(result, (1.75, 1750000, 6))
        body = fake.requests[0]["json"]
        self.assertEqual(body["method"], "getTokenAccountsByOwner")
        self.assertEqual(body["params"][0], PUB_B58)
        self.assertEqual(body["params"][1], {"mint": solana.USDC_MINT})
        self.assertEqual(body["params"][2]["encoding"], "jsonParsed")

    def test_get_token_balance_without_accounts(self):
        result, fake = self.run_with(
            [
                rpc_ok({"context": {"slot": 1}, "value": []}),
                rpc_ok({"context": {"slot": 1}, "value": {"amount": "1", "decimals": 9}}),
            ],
            lambda: self.rpc.get_token_balance(PUB, solana.SOL_MINT),
        )
        self.assertEqual(result, (0.0, 0, 9))
        self.assertEqual([r["json"]["method"] for r in fake.requests], ["getTokenAccountsByOwner", "getTokenSupply"])
        self.assertEqual(fake.requests[0]["json"]["params"][0], PUB_B58)

    def test_rpc_error_carries_message(self):
        with self.assertRaises(solana.SolanaError) as cm:
            self.run_with([rpc_err(-32602, "Invalid param: WrongSize")], lambda: self.rpc.get_balance(PUB))
        self.assertNotIsInstance(cm.exception, solana.TransportError)
        self.assertIn("Invalid param: WrongSize", str(cm.exception))
        self.assertEqual(cm.exception.code, -32602)

    def test_http_and_network_errors_are_transport_errors(self):
        for reply in (
            http_error("https://rpc.example.com", 429, "Too many requests"),
            urllib.error.URLError("timed out"),
            socket.timeout("timed out"),
            ConnectionResetError("reset"),
            FakeResponse(b"<html>bad gateway</html>"),
        ):
            with self.subTest(type(reply).__name__):
                with self.assertRaises(solana.TransportError):
                    self.run_with([reply], lambda: self.rpc.get_balance(PUB))

    def test_json_rpc_error_on_http_error_status_is_definite(self):
        reply = http_error("https://rpc.example.com", 500, json.dumps(rpc_err(-32005, "Node is behind")))
        with self.assertRaises(solana.SolanaError) as cm:
            self.run_with([reply], lambda: self.rpc.get_balance(PUB))
        self.assertNotIsInstance(cm.exception, solana.TransportError)
        self.assertIn("Node is behind", str(cm.exception))

    def test_url_with_api_key_never_appears(self):
        url = "https://mainnet.example-rpc.com/tok3nPath?api-key=SUPERSECRETKEY"
        rpc = solana.Rpc(url)
        self.assertEqual(repr(rpc), "Rpc(https://mainnet.example-rpc.com)")
        fake = FakeHTTP([urllib.error.URLError("cannot reach " + url), http_error(url, 403, "forbidden")])
        with mock.patch.object(solana, "_urlopen", fake):
            for _ in range(2):
                with self.assertRaises(solana.TransportError) as cm:
                    rpc.get_balance(PUB)
                exc = cm.exception
                while exc is not None:  # urllib errors keep the URL; none may be chained
                    text = str(exc) + repr(exc) + repr(vars(exc))
                    self.assertNotIn("SUPERSECRETKEY", text)
                    self.assertNotIn("tok3nPath", text)
                    exc = exc.__cause__ or exc.__context__

    def test_send_raw(self):
        signed = solana.sign_tx(unsigned_tx(v0_swap_message()), SECRET64)
        expected = solana.tx_signature(signed)
        result, fake = self.run_with([rpc_ok(expected)], lambda: self.rpc.send_raw(signed))
        self.assertEqual(result, expected)
        body = fake.requests[0]["json"]
        self.assertEqual(body["method"], "sendTransaction")
        encoded, config = body["params"]
        self.assertEqual(base64.b64decode(encoded), signed)
        self.assertEqual(config["encoding"], "base64")
        self.assertIs(config["skipPreflight"], False)
        self.assertEqual(config["maxRetries"], 3)

    def test_send_raw_options(self):
        signed = solana.sign_tx(unsigned_tx(legacy_transfer_message()), SECRET64)
        expected = solana.tx_signature(signed)
        _, fake = self.run_with(
            [rpc_ok(expected)], lambda: self.rpc.send_raw(signed, skip_preflight=True, max_retries=None)
        )
        config = fake.requests[0]["json"]["params"][1]
        self.assertIs(config["skipPreflight"], True)
        self.assertNotIn("maxRetries", config)

    def test_send_raw_refuses_unsigned(self):
        fake = FakeHTTP([])
        with mock.patch.object(solana, "_urlopen", fake):
            with self.assertRaises(ValueError):
                self.rpc.send_raw(unsigned_tx(legacy_transfer_message()))
        self.assertEqual(fake.requests, [])

    def test_send_raw_preflight_failure(self):
        signed = solana.sign_tx(unsigned_tx(v0_swap_message()), SECRET64)
        data = {
            "err": {"InstructionError": [3, {"Custom": 6001}]},
            "logs": ["Program JUP6 invoke [1]", "Program log: Error: SlippageToleranceExceeded", "Program JUP6 failed"],
        }
        reply = rpc_err(-32002, "Transaction simulation failed: custom program error: 0x1771", data)
        with self.assertRaises(solana.SolanaError) as cm:
            self.run_with([reply], lambda: self.rpc.send_raw(signed))
        err = cm.exception
        self.assertNotIsInstance(err, solana.TransportError)
        self.assertIn("0x1771", str(err))
        self.assertIn("SlippageToleranceExceeded", str(err))
        self.assertIsNone(err.signature, "a rejected send was definitely not broadcast")

    def test_send_raw_timeout_reports_signature(self):
        signed = solana.sign_tx(unsigned_tx(v0_swap_message()), SECRET64)
        with self.assertRaises(solana.TransportError) as cm:
            self.run_with([socket.timeout("timed out")], lambda: self.rpc.send_raw(signed))
        self.assertEqual(cm.exception.signature, solana.tx_signature(signed))

    def test_send_raw_signature_mismatch(self):
        signed = solana.sign_tx(unsigned_tx(v0_swap_message()), SECRET64)
        with self.assertRaises(solana.SolanaError):
            self.run_with([rpc_ok("1" * 64)], lambda: self.rpc.send_raw(signed))

    def confirm_with(self, script, timeout_s=60.0):
        clock = FakeClock()
        fake = FakeHTTP(script)
        with mock.patch.object(solana, "_urlopen", fake), mock.patch.object(
            solana, "_monotonic", clock.monotonic
        ), mock.patch.object(solana, "_sleep", clock.sleep):
            result = self.rpc.confirm("SIG", timeout_s=timeout_s, poll_s=2.0)
        return result, fake, clock

    def test_confirm_waits_for_confirmed(self):
        result, fake, clock = self.confirm_with([
            status_reply(None),
            status_reply({"slot": 9, "confirmations": 0, "err": None, "confirmationStatus": "processed"}),
            status_reply({"slot": 9, "confirmations": 1, "err": None, "confirmationStatus": "confirmed"}),
        ])
        self.assertEqual(result, "confirmed")
        self.assertEqual(len(fake.requests), 3)
        self.assertEqual(clock.sleeps, [2.0, 2.0])
        body = fake.requests[0]["json"]
        self.assertEqual(body["method"], "getSignatureStatuses")
        self.assertEqual(body["params"][0], ["SIG"])

    def test_confirm_finalized(self):
        result, _, _ = self.confirm_with(
            [status_reply({"slot": 9, "confirmations": None, "err": None, "confirmationStatus": "finalized"})]
        )
        self.assertEqual(result, "finalized")

    def test_confirm_failed(self):
        err = {"InstructionError": [3, {"Custom": 6001}]}
        result, _, _ = self.confirm_with(
            [status_reply({"slot": 9, "confirmations": 1, "err": err, "confirmationStatus": "confirmed"})]
        )
        self.assertTrue(result.startswith("failed: "), result)
        self.assertEqual(json.loads(result[len("failed: "):]), err)

    def test_confirm_timeout(self):
        result, fake, clock = self.confirm_with(lambda req: status_reply(None), timeout_s=10.0)
        self.assertEqual(result, "timeout")
        self.assertAlmostEqual(sum(clock.sleeps), 10.0)
        self.assertEqual(len(fake.requests), 6)

    def test_signature_status_is_one_look_through_history(self):
        result, fake = self.run_with([status_reply(None)], lambda: self.rpc.signature_status("SIG"))
        self.assertIsNone(result)  # the cluster never saw it
        self.assertTrue(fake.requests[0]["json"]["params"][1]["searchTransactionHistory"])
        ok = {"slot": 9, "confirmations": None, "err": None, "confirmationStatus": "finalized"}
        self.assertEqual(self.run_with([status_reply(ok)], lambda: self.rpc.signature_status("SIG"))[0], "finalized")
        bad = dict(ok, err={"InstructionError": [2, {"Custom": 1}]})
        self.assertTrue(self.run_with([status_reply(bad)], lambda: self.rpc.signature_status("SIG"))[0].startswith("failed"))
        with self.assertRaises(solana.SolanaError):  # no answer is not "not found"
            self.run_with([rpc_ok({"context": {"slot": 1}})], lambda: self.rpc.signature_status("SIG"))

    def test_confirm_survives_transient_errors(self):
        result, fake, _ = self.confirm_with([
            urllib.error.URLError("flaky"),
            rpc_err(-32005, "Node is behind"),
            status_reply({"slot": 9, "confirmations": 1, "err": None, "confirmationStatus": "confirmed"}),
        ])
        self.assertEqual(result, "confirmed")
        self.assertEqual(len(fake.requests), 3)


class JupiterTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.quote = load_fixture("jupiter_quote_sol_usdc.json")

    def test_quote_request(self):
        fake = FakeHTTP([self.quote])
        with mock.patch.object(solana, "_urlopen", fake):
            q = solana.jupiter_quote(solana.SOL_MINT, solana.USDC_MINT, 10_000_000, 50)
        self.assertEqual(q, self.quote)
        req = fake.requests[0]
        self.assertEqual(req["method"], "GET")
        self.assertIsNone(req["body"])
        url = urllib.parse.urlsplit(req["url"])
        self.assertEqual("%s://%s%s" % (url.scheme, url.netloc, url.path), solana.JUPITER_QUOTE_URL)
        self.assertEqual(url.netloc, "lite-api.jup.ag")
        self.assertEqual(
            dict(urllib.parse.parse_qsl(url.query)),
            {"inputMint": solana.SOL_MINT, "outputMint": solana.USDC_MINT, "amount": "10000000", "slippageBps": "50"},
        )

    def test_quote_must_match_request(self):
        for field, value in (("inAmount", "999"), ("outputMint", solana.SOL_MINT), ("inputMint", solana.USDC_MINT)):
            bad = dict(self.quote)
            bad[field] = value
            with mock.patch.object(solana, "_urlopen", FakeHTTP([bad])):
                with self.assertRaises(solana.JupiterError):
                    solana.jupiter_quote(solana.SOL_MINT, solana.USDC_MINT, 10_000_000, 50)

    def test_quote_api_error(self):
        body = json.dumps({"error": "Could not find any route", "errorCode": "COULD_NOT_FIND_ANY_ROUTE"})
        fake = FakeHTTP([http_error(solana.JUPITER_QUOTE_URL, 400, body)])
        with mock.patch.object(solana, "_urlopen", fake):
            with self.assertRaises(solana.JupiterError) as cm:
                solana.jupiter_quote(solana.SOL_MINT, solana.USDC_MINT, 10_000_000, 50)
        self.assertIn("Could not find any route", str(cm.exception))
        self.assertEqual(cm.exception.code, 400)

    def test_quote_validates_input_before_any_request(self):
        fake = FakeHTTP([])
        bad_calls = [
            (solana.SOL_MINT, solana.USDC_MINT, 0, 50),
            (solana.SOL_MINT, solana.USDC_MINT, -5, 50),
            (solana.SOL_MINT, solana.USDC_MINT, 1.5, 50),
            (solana.SOL_MINT, solana.USDC_MINT, True, 50),
            (solana.SOL_MINT, solana.USDC_MINT, 100, 10_001),
            (solana.SOL_MINT, solana.USDC_MINT, 100, -1),
            (solana.SOL_MINT, solana.SOL_MINT, 100, 50),
            ("nope", solana.USDC_MINT, 100, 50),
        ]
        with mock.patch.object(solana, "_urlopen", fake):
            for args in bad_calls:
                with self.subTest(args=args):
                    with self.assertRaises(ValueError):
                        solana.jupiter_quote(*args)
        self.assertEqual(fake.requests, [])

    def swap_reply(self, message=None, **extra):
        raw = unsigned_tx(message or v0_swap_message())
        reply = {"swapTransaction": base64.b64encode(raw).decode(), "lastValidBlockHeight": 123, "prioritizationFeeLamports": 0}
        reply.update(extra)
        return reply, raw

    def test_swap_tx_request_body(self):
        reply, raw = self.swap_reply()
        fake = FakeHTTP([reply])
        with mock.patch.object(solana, "_urlopen", fake):
            out = solana.jupiter_swap_tx(self.quote, PUB_B58, priority_lamports=50_000)
        self.assertEqual(out, raw)
        req = fake.requests[0]
        self.assertEqual(req["method"], "POST")
        self.assertEqual(req["url"], solana.JUPITER_SWAP_URL)
        self.assertEqual(req["headers"].get("Content-type"), "application/json")
        self.assertEqual(
            req["json"],
            {
                "quoteResponse": self.quote,
                "userPublicKey": PUB_B58,
                "wrapAndUnwrapSol": True,
                "dynamicComputeUnitLimit": True,
                "prioritizationFeeLamports": 50_000,
            },
        )

    def test_swap_tx_priority_options(self):
        level = {"priorityLevelWithMaxLamports": {"maxLamports": 1_000_000, "priorityLevel": "high"}}
        for priority, expected in ((None, None), ("auto", "auto"), (level, level), (0, 0)):
            reply, _ = self.swap_reply()
            fake = FakeHTTP([reply])
            with mock.patch.object(solana, "_urlopen", fake):
                solana.jupiter_swap_tx(self.quote, PUB, priority_lamports=priority)
            body = fake.requests[0]["json"]
            self.assertEqual(body["userPublicKey"], PUB_B58)
            if expected is None:
                self.assertNotIn("prioritizationFeeLamports", body)
            else:
                self.assertEqual(body["prioritizationFeeLamports"], expected)
        for bad in (-1, True, "fast", 1.5):
            with self.assertRaises(ValueError):
                solana.jupiter_swap_tx(self.quote, PUB, priority_lamports=bad)

    def test_swap_tx_rejects_bad_responses(self):
        foreign, _ = self.swap_reply(v0_swap_message(payer=OTHER_PUB))
        simulated, _ = self.swap_reply(simulationError={"error": "Insufficient funds"})
        cases = {
            "foreign payer": foreign,
            "simulation error": simulated,
            "missing tx": {"lastValidBlockHeight": 1},
            "bad base64": {"swapTransaction": "!!!not base64!!!"},
            "not a tx": {"swapTransaction": base64.b64encode(b"\x01garbage").decode()},
            "http error": http_error(solana.JUPITER_SWAP_URL, 422, json.dumps({"error": "Invalid quote"})),
            "network": urllib.error.URLError("down"),
        }
        for name, reply in cases.items():
            with self.subTest(name):
                with mock.patch.object(solana, "_urlopen", FakeHTTP([reply])):
                    with self.assertRaises(solana.JupiterError):
                        solana.jupiter_swap_tx(self.quote, PUB_B58)


class SwapTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.quote = load_fixture("jupiter_quote_sol_usdc.json")

    def router(self, payer=PUB, send_reply=None, unsigned=None):
        """A fake internet: Jupiter + one RPC node."""
        unsigned = unsigned or unsigned_tx(v0_swap_message(payer=payer))
        self.unsigned = unsigned
        self.sent = []

        def handle(req):
            if req["url"].startswith(solana.JUPITER_QUOTE_URL):
                return self.quote
            if req["url"] == solana.JUPITER_SWAP_URL:
                return {"swapTransaction": base64.b64encode(unsigned).decode(), "lastValidBlockHeight": 1}
            method = req["json"]["method"]
            if method == "sendTransaction":
                raw = base64.b64decode(req["json"]["params"][0])
                self.sent.append(raw)
                if send_reply is not None:
                    return send_reply
                return rpc_ok(solana.tx_signature(raw))
            if method == "getSignatureStatuses":
                return status_reply({"slot": 1, "confirmations": 1, "err": None, "confirmationStatus": "confirmed"})
            raise AssertionError("unexpected request %r" % method)

        return FakeHTTP(handle)

    def run_swap(self, fake, secret=SECRET64, priority=None):
        rpc = solana.Rpc("https://rpc.example.com")
        with mock.patch.object(solana, "_urlopen", fake), mock.patch.object(solana, "_sleep", lambda s: None):
            return solana.swap(rpc, secret, solana.SOL_MINT, solana.USDC_MINT, 10_000_000, 50, priority)

    def test_end_to_end(self):
        fake = self.router()
        logger = logging.getLogger(solana.log.name)
        with self.assertLogs(logger, level="DEBUG") as logs:
            result = self.run_swap(fake, priority=10_000)
        self.assertEqual(result["status"], "confirmed")
        self.assertEqual(result["quote"], self.quote)
        self.assertEqual(len(self.sent), 1)
        sent = self.sent[0]
        self.assertTrue(solana.verify_tx(sent))
        self.assertEqual(result["signature"], solana.tx_signature(sent))
        parsed = solana.parse_tx(sent)
        self.assertEqual(parsed["message"], solana.parse_tx(self.unsigned)["message"], "message must be Jupiter's, untouched")
        self.assertTrue(solana.verify(PUB, parsed["message"], parsed["signatures"][0]))

        order = []
        for req in fake.requests:
            order.append(req["json"]["method"] if req["url"] == "https://rpc.example.com" else req["url"].split("?")[0])
        self.assertEqual(order, [solana.JUPITER_QUOTE_URL, solana.JUPITER_SWAP_URL, "sendTransaction", "getSignatureStatuses"])
        self.assertEqual(fake.requests[1]["json"]["prioritizationFeeLamports"], 10_000)

        # The key must never leave the process: only the signed tx does.
        for req in fake.requests:
            text = req["url"] + json.dumps(req["headers"]) + (req["body"] or b"").decode()
            self.assertIsNone(leaked(text), req["url"])
            self.assertFalse(leaked_bytes(req["body"] or b""))
        for line in logs.output:
            self.assertIsNone(leaked(line), line)

    def test_secret_forms(self):
        for secret in (solana.b58encode(SECRET64), json.dumps(list(SECRET64)), solana.Keypair(SEED)):
            result = self.run_swap(self.router(), secret=secret)
            self.assertEqual(result["status"], "confirmed")

    def test_refuses_foreign_payer_without_sending(self):
        fake = self.router(payer=OTHER_PUB)
        with self.assertRaises(solana.JupiterError):
            self.run_swap(fake)
        self.assertEqual(self.sent, [])
        self.assertTrue(all("jup.ag" in r["url"] for r in fake.requests))

    def test_refuses_to_send_tx_needing_another_signer(self):
        keys = [PUB, OTHER_PUB, JUPITER_PROGRAM]
        message = build_message(0, (2, 1, 1), keys, key("blockhash"), [(2, [0, 1], b"\x01")])
        fake = self.router(unsigned=unsigned_tx(message, 2))
        with self.assertRaises(solana.SolanaError) as cm:
            self.run_swap(fake)
        self.assertIn("does not verify", str(cm.exception))
        self.assertEqual(self.sent, [])

    def test_send_timeout_surfaces_signature(self):
        fake = self.router(send_reply=socket.timeout("timed out"))
        with self.assertRaises(solana.TransportError) as cm:
            self.run_swap(fake)
        self.assertIsNotNone(cm.exception.signature)
        self.assertEqual(cm.exception.signature, solana.tx_signature(self.sent[0]))
        methods = [r["json"]["method"] for r in fake.requests if r["json"] and "method" in r["json"]]
        self.assertNotIn("getSignatureStatuses", methods)

    def test_before_send_runs_after_signing_and_before_anything_is_sent(self):
        fake = self.router()
        seen = []

        def record(signature, quote):
            seen.append((signature, quote["outAmount"], len(self.sent)))
        rpc = solana.Rpc("https://rpc.example.com")
        with mock.patch.object(solana, "_urlopen", fake), mock.patch.object(solana, "_sleep", lambda s: None):
            result = solana.swap(rpc, SECRET64, solana.SOL_MINT, solana.USDC_MINT, 10_000_000, 50, before_send=record)
        self.assertEqual(seen, [(result["signature"], self.quote["outAmount"], 0)])  # nothing sent yet

        def refuse(signature, quote):
            raise OSError("disk full")  # the record couldn't be written: then nothing goes out
        fake = self.router()
        with mock.patch.object(solana, "_urlopen", fake), mock.patch.object(solana, "_sleep", lambda s: None):
            with self.assertRaises(OSError):
                solana.swap(rpc, SECRET64, solana.SOL_MINT, solana.USDC_MINT, 10_000_000, 50, before_send=refuse)
        self.assertEqual(self.sent, [])

    def test_failed_swap_is_reported_not_hidden(self):
        fake = self.router()
        original = fake.script

        def handle(req):
            if req["json"] and req["json"].get("method") == "getSignatureStatuses":
                return status_reply({"slot": 1, "confirmations": 1, "err": {"InstructionError": [3, {"Custom": 6001}]},
                                     "confirmationStatus": "confirmed"})
            return original(req)

        fake.script = handle
        result = self.run_swap(fake)
        self.assertTrue(result["status"].startswith("failed: "))


class NoSecretInErrorsTests(unittest.TestCase):
    def test_leak_detector_catches_partial_leaks(self):
        for fragment in (
            solana.b58encode(SECRET64)[30:45],
            SEED.hex()[10:30],
            repr(SEED),
            str(list(SEED))[5:40],
            base64.b64encode(SEED).decode()[3:20],
        ):
            self.assertIsNotNone(leaked("error: " + fragment + " trailing"), fragment)
        signed = solana.sign_tx(unsigned_tx(v0_swap_message()), SECRET64)
        for public in (PUB_B58, PUB.hex(), base64.b64encode(signed).decode(), repr(solana.Keypair(SEED))):
            self.assertIsNone(leaked(public), public)
        self.assertTrue(leaked_bytes(b"xx" + SEED[3:15]))
        self.assertFalse(leaked_bytes(signed))

    def assert_clean(self, exc):
        rendered = ["".join(traceback.format_exception(type(exc), exc, exc.__traceback__))]
        # Error reporters may walk __context__ even when "from None" hides it
        # from the printed traceback, so every link of the chain must be clean.
        seen = set()
        while exc is not None and id(exc) not in seen:
            seen.add(id(exc))
            rendered += [str(exc), repr(exc), repr(exc.args)]
            exc = exc.__cause__ or exc.__context__
        for text in rendered:
            self.assertIsNone(leaked(text), text)

    def capture(self, fn):
        try:
            fn()
        except Exception as e:  # noqa: BLE001 - any error type is fine here
            return e
        self.fail("expected an exception")

    def test_key_loading_errors(self):
        b58 = solana.b58encode(SECRET64)
        corrupt_char = b58[:20] + "0" + b58[21:]
        unicode_char = b58[:20] + "é" + b58[21:]
        cases = [
            lambda: solana.load_keypair(corrupt_char),
            lambda: solana.load_keypair(unicode_char),
            lambda: solana.load_keypair(b58[:-4]),
            lambda: solana.load_keypair(json.dumps(list(SECRET64)[:63])),
            lambda: solana.load_keypair(json.dumps(list(SECRET64)[:-1] + [999])),
            lambda: solana.load_keypair(json.dumps(list(SECRET64))[:-1] + ",]"),
            lambda: solana.load_keypair(SEED + OTHER_PUB),
            lambda: solana.load_keypair(list(SEED) + [-1]),
            lambda: solana.b58decode(SEED),
            lambda: solana.b58decode(corrupt_char),
            lambda: solana.b58decode(unicode_char.encode("utf-8")),
            lambda: solana.sign(corrupt_char, b"m"),
            lambda: solana.Keypair(SECRET64[:40]),
        ]
        for fn in cases:
            self.assert_clean(self.capture(fn))

    def test_keypair_file_errors(self):
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "id.json")
            with open(path, "w") as fh:
                fh.write(json.dumps(list(SECRET64))[:-1] + ", 300]")
            self.assert_clean(self.capture(lambda: solana.load_keypair_file(path)))

    def test_transaction_and_rpc_errors(self):
        foreign = unsigned_tx(v0_swap_message(payer=OTHER_PUB))
        self.assert_clean(self.capture(lambda: solana.sign_tx(foreign, SECRET64)))
        self.assert_clean(self.capture(lambda: solana.sign_tx(b"\x01", SECRET64)))
        rpc = solana.Rpc("https://rpc.example.com")
        self.assert_clean(self.capture(lambda: rpc.get_balance(solana.b58encode(SECRET64))))
        self.assert_clean(self.capture(lambda: rpc.get_token_balance(solana.b58encode(SEED + b"x"), solana.USDC_MINT)))
        with mock.patch.object(solana, "_urlopen", FakeHTTP([urllib.error.URLError("down")])):
            self.assert_clean(self.capture(lambda: solana.swap(rpc, SECRET64, solana.SOL_MINT, solana.USDC_MINT, 1, 50)))


if __name__ == "__main__":
    unittest.main()
