"""Meme sniper: the checks from a careful trader's list (liquidity at our size, holders, rug pull and honeypot,
fake hype), the three strategies, the budget, the exits — and live only after every step of the opt-in."""
from __future__ import annotations

import os
from unittest import mock

from shared import config, http, market_clock as mc, state
from shared.indicators import Candle
from tests.helpers import TraderTestCase, load

NOW = "2026-10-22T10:00:00Z"


def sn():
    return load("trader-sniper", "sniper")


def pair(**kw):
    p = {"chain": "solana", "dex": "pumpswap", "pair_address": "POOL", "url": "https://dexscreener.com/x",
         "base": {"address": "MINT", "symbol": "FROG", "name": "Frog"}, "price_usd": 0.001,
         "liquidity_usd": 80000.0, "created_at": mc.ts(NOW) - 3 * 3600,
         "volume": {"m5": 9000.0, "h1": 24000.0, "h6": 90000.0, "h24": 200000.0},
         "txns": {"m5": {"buys": 60, "sells": 20}, "h1": {"buys": 300, "sells": 200}},
         "price_change": {"m5": 6.0, "h1": 12.0, "h6": 40.0, "h24": 80.0}}
    p.update(kw)
    return p


def cand(**kw):
    c = {"chain": "solana", "address": "MINT", "source": "test"}
    c.update(kw)
    return c


def verified(chain="solana", without=()):
    """The checks the sniper needs positively answered before it may buy."""
    names = ("mint_authority", "freeze_authority", "lp_locked", "top10") if chain == "solana" else ("honeypot", "top10")
    return [{"name": n, "ok": True, "severity": "critical", "penalty": 0} for n in names if n not in without]


class Settings(TraderTestCase):
    def s(self, **kw):
        cfg = config.load_config()
        cfg["sniper"].update(kw)
        return sn().settings(cfg)


class Prefilter(Settings):
    NOW = NOW

    def test_the_cheap_reasons(self):
        s, now = self.s(), mc.ts(NOW)
        self.assertEqual(sn().prefilter(cand(), pair(), s, now), [])
        self.assertTrue(sn().prefilter(cand(), pair(base={"address": "x", "symbol": "USDC"}), s, now))
        self.assertIn("too young", sn().prefilter(cand(), pair(created_at=now - 120), s, now)[0])
        self.assertIn("liquidity", sn().prefilter(cand(), pair(liquidity_usd=9000.0), s, now)[0])
        washed = pair(volume={"m5": 0, "h1": 3e6, "h6": 0, "h24": 0})
        self.assertIn("wash", " ".join(sn().prefilter(cand(), washed, s, now)))
        bots = cand(pool={"txns": {"h1": {"buys": 900, "sells": 900, "buyers": 40, "sellers": 40}}})
        self.assertIn("bots", " ".join(sn().prefilter(bots, pair(), s, now)))

    def test_a_bonding_curve_is_judged_by_our_round_trip_not_its_pool(self):
        self.assertEqual(sn().prefilter(cand(), pair(dex="pumpfun", liquidity_usd=0.0), self.s(), mc.ts(NOW)), [])


class Safety(Settings):
    NOW = NOW

    def rug(self, checks, verdict="SAFE"):
        r = mock.Mock()
        r.check.return_value = {"checks": checks, "verdict": verdict, "reasons": [c.get("reason", c["name"]) for c in checks
                                                                                  if c.get("ok") is False],
                                "metrics": {}}
        return r

    def judge(self, checks, p=None, verdict="SAFE", chain="solana"):
        mod, st = sn(), self.s()  # both before skills.load is patched (it loads the sniper too)
        with mock.patch.object(mod.skills, "load", return_value=self.rug(checks, verdict)):
            self.n = getattr(self, "n", 0) + 1  # a token of its own each time: answers are cached per token
            return mod.safety(cand(chain=chain, address="T%d" % self.n), p or pair(), st, mc.ts(NOW))

    def test_a_critical_failure_or_no_answer_is_no(self):
        crit = {"name": "mint_authority", "ok": False, "severity": "critical", "penalty": 40}
        self.assertFalse(self.judge(verified(without=["mint_authority"]) + [crit], verdict="DANGER")["ok"])
        down = {"name": "safety_source", "ok": False, "severity": "high", "penalty": 20}
        self.assertFalse(self.judge([down], verdict="RISKY")["ok"])
        self.assertTrue(self.judge(verified())["ok"])

    def test_a_curve_has_no_lp_to_lock(self):
        lp = {"name": "lp_locked", "ok": False, "severity": "critical", "penalty": 30, "reason": "LP not locked"}
        self.assertFalse(self.judge(verified(without=["lp_locked"]) + [lp], verdict="DANGER")["ok"])
        self.assertTrue(self.judge(verified(without=["lp_locked"]) + [lp], p=pair(dex="pumpfun"), verdict="DANGER")["ok"])

    def test_could_not_verify_is_no_never_a_pass(self):
        unknown = {"name": "freeze_authority", "ok": None, "severity": "medium", "penalty": 10}
        r = self.judge(verified(without=["freeze_authority"]) + [unknown])
        self.assertFalse(r["ok"])
        self.assertIn("not verified: freeze authority", r["reasons"][0])
        self.assertEqual(r["score"], 90)  # an unanswered check costs its points too
        self.assertFalse(self.judge(verified(without=["top10"]))["ok"])  # not even asked: not verified either
        # EVM (paper only): the honeypot simulation must have run; LP locks can't be read there from free sources
        lp_unknown = {"name": "lp_locked", "ok": None, "severity": "medium", "penalty": 10}
        evm = pair(chain="base", dex="uniswap")
        self.assertTrue(self.judge(verified("base") + [lp_unknown], p=evm, chain="base")["ok"])
        hp_unknown = {"name": "honeypot", "ok": None, "severity": "high", "penalty": 15}
        self.assertFalse(self.judge(verified("base", without=["honeypot"]) + [hp_unknown], p=evm, chain="base")["ok"])

    def test_a_report_without_the_authorities_is_not_enough(self):
        """RugCheck's short summary (the fallback when the full report fails) has no mint or freeze authority: the
        real check marks them "unknown" — and the sniper doesn't buy what it couldn't check."""
        mod, st = sn(), self.s()
        rug = load("trader-rugcheck", "rugcheck")
        summary = {"risks": [{"name": "Freeze Authority still enabled", "value": "", "level": "danger",
                              "description": "Tokens can be frozen", "score": 7500}],
                   "score": 7501, "score_normalised": 45, "lpLockedPct": 100}
        with mock.patch.object(rug.rugcheck_api, "report", return_value=summary) as rep, \
                mock.patch.object(mod.skills, "load", return_value=rug):
            r = mod.safety(cand(address="FRZ"), pair(liquidity_usd=150000.0), st, mc.ts(NOW))
        self.assertFalse(r["ok"])
        self.assertIn("mint authority", r["reasons"][0])
        self.assertTrue(rep.call_args[1].get("fresh"))  # and never an older cached report


class RoundTrip(Settings):
    def test_evm_pool_depth_and_fees(self):
        rt = sn().roundtrip(cand(chain="base"), pair(chain="base", dex="uniswap", liquidity_usd=20000.0), self.s())
        # $10 into $10k a side: 0.1 % impact each way, 0.3 % fee each way, $0.05 gas each way
        self.assertAlmostEqual(rt["loss_pct"], 2 * (0.1 + 0.3) + 100 * 2 * 0.05 / 10, places=2)

    def test_jupiter_says_no_route_or_says_nothing_and_never_an_old_quote(self):
        import io
        import time as _time
        import urllib.error
        import urllib.request
        os.environ.pop("TRADER_OFFLINE", None)  # restored by tearDown
        jup = sn().jupiter
        url = "%s/quote?inputMint=MINT&outputMint=%s&amount=1000&slippageBps=300" % (jup.BASE, jup.SOL_MINT)
        http._get_cache().set(url, '{"inAmount":"1000","outAmount":"500000000","routePlan":[]}',
                              fetched_at=_time.time() - 3600)  # it sold fine an hour ago

        def answer(code):
            def fake(req, timeout=None):
                raise urllib.error.HTTPError(req.full_url, code, "x", {}, io.BytesIO(b'{"error":"no route"}'))
            return fake
        with mock.patch.object(urllib.request, "urlopen", side_effect=answer(400)):
            with self.assertRaises(jup.NoRoute):
                jup.quote("MINT", jup.SOL_MINT, 1000, 300)
        with mock.patch.object(urllib.request, "urlopen", side_effect=answer(429)), \
                mock.patch.object(http.time, "sleep"):
            with self.assertRaises(http.SourceError) as cm:
                jup.quote("MINT", jup.SOL_MINT, 1000, 300)
        self.assertNotIsInstance(cm.exception, jup.NoRoute)  # no answer is not an answer about the token

    def test_solana_asks_jupiter_both_ways_and_no_route_is_a_honeypot(self):
        quotes = iter([{"out_raw": 150_000_000, "price_impact_pct": 0, "route": []},       # 1 SOL = $150
                       {"out_raw": 5_000_000, "price_impact_pct": 0.4, "route": ["PumpSwap"]},  # buy
                       {"out_raw": 63_000_000, "price_impact_pct": 0.4, "route": ["PumpSwap"]}])  # sell back
        with mock.patch.object(sn().jupiter, "quote", side_effect=lambda *a, **k: next(quotes)):
            rt = sn().roundtrip(cand(), pair(), self.s())
        self.assertAlmostEqual(rt["loss_pct"], 5.5, places=1)  # $10 in, 0.063 SOL × 150 = $9.45 back
        with mock.patch.object(sn().jupiter, "quote", side_effect=http.SourceError("jupiter", "no route")):
            with self.assertRaises(http.SourceError):
                sn().roundtrip(cand(), pair(), self.s())


def bars(prices, vols=None, start=None):
    start = start if start is not None else mc.ts(NOW) - 300 * (len(prices) + 1)
    out = []
    for i, p in enumerate(prices):
        v = (vols or [100.0] * len(prices))[i]
        out.append(Candle(start + 300 * i, p, p * 1.01, p * 0.99, p, v))
    return out


class Strategies(Settings):
    NOW = NOW

    def test_momentum_fires_before_the_crowd_not_after(self):
        s, now = self.s(), mc.ts(NOW)
        sig = sn().signal(cand(), pair(), s, now, fetch_bars=lambda *a: [])
        self.assertEqual(sig["strategy"], "momentum")
        late = pair(price_change={"m5": 6.0, "h1": 450.0, "h6": 0, "h24": 0})
        self.assertNotEqual(sn().signal(cand(), late, s, now, fetch_bars=lambda *a: []).get("strategy"), "momentum")
        dumping = pair(txns={"m5": {"buys": 10, "sells": 40}, "h1": {"buys": 1, "sells": 1}})
        self.assertEqual(sn().signal(cand(), dumping, s, now, fetch_bars=lambda *a: []), {})

    def test_breakout_after_a_quiet_range(self):
        s, now = self.s(strategies={"momentum": False}), mc.ts(NOW)
        quiet = pair(volume={"m5": 0, "h1": 0, "h6": 0, "h24": 0})
        b = bars([1.0, 1.05] * 13 + [1.30], [100.0] * 26 + [400.0])
        sig = sn().signal(cand(), quiet, s, now, fetch_bars=lambda *a: b)
        self.assertEqual(sig["strategy"], "breakout")
        self.assertLessEqual(sig["stop_pct"], 25)

    def test_pullback_after_a_strong_run(self):
        s, now = self.s(strategies={"momentum": False, "breakout": False}), mc.ts(NOW)
        run = [1.0 + 0.1 * i for i in range(12)]          # 1.0 → 2.1
        dip = [2.1 - 0.08 * i for i in range(1, 12)]      # back to ~1.22 (≈ 42 % off the high)
        flat = [1.25] * 10
        b = bars(run + dip + flat + [1.6])
        sig = sn().signal(cand(), pair(volume={"m5": 0, "h1": 0, "h6": 0, "h24": 0}), s, now, fetch_bars=lambda *a: b)
        self.assertEqual(sig.get("strategy"), "pullback", sig)

    def test_graduation_is_off_unless_switched_on(self):
        pf = {"curve_progress": 0.95, "replies": 40, "banned": False}
        quiet = pair(volume={"m5": 0, "h1": 0, "h6": 0, "h24": 0}, created_at=mc.ts(NOW) - 3600)
        self.assertEqual(sn().signal(cand(pumpfun=pf), quiet, self.s(), mc.ts(NOW), fetch_bars=lambda *a: []), {})
        on = self.s(strategies={"graduation": True})
        self.assertEqual(sn().signal(cand(pumpfun=pf), quiet, on, mc.ts(NOW), fetch_bars=lambda *a: [])["strategy"],
                         "graduation")


class Budget(Settings):
    NOW = NOW

    def test_every_cap(self):
        s, now = self.s(), mc.ts(NOW)
        book = {"positions": {}, "days": {}, "traded": {}}
        self.assertEqual(sn().budget_refusal(book, s, now, "solana:A"), "")
        book["positions"] = {"solana:%d" % i: {"cost_usd": 10.0} for i in range(10)}
        self.assertIn("positions open", sn().budget_refusal(book, s, now, "solana:A"))
        book["positions"] = {"solana:%d" % i: {"cost_usd": 19.0} for i in range(5)}
        self.assertIn("cap is $100", sn().budget_refusal(book, s, now, "solana:A"))
        book = {"positions": {}, "days": {NOW[:10]: {"trades": 20, "pnl_usd": 0.0}}, "traded": {}}
        self.assertIn("trades today", sn().budget_refusal(book, s, now, "solana:A"))
        book = {"positions": {}, "days": {NOW[:10]: {"trades": 1, "pnl_usd": -31.0}}, "traded": {}}
        self.assertIn("lost", sn().budget_refusal(book, s, now, "solana:A"))
        book = {"positions": {}, "days": {}, "traded": {"solana:A": now - 3600}}
        self.assertIn("24 h", sn().budget_refusal(book, s, now, "solana:A"))


class Exits(Settings):
    NOW = NOW

    def position(self, **kw):
        p = {"chain": "base", "address": "TOK", "symbol": "TOK", "dex": "uniswap", "strategy": "momentum",
             "opened_at": NOW, "entry_price": 1.0, "cost_usd": 10.0, "stop_pct": 25.0, "peak_price": 1.0,
             "entry_liquidity": 100000.0, "mode": "paper", "price_unit": "usd", "tokens": 10.0, "url": ""}
        p.update(kw)
        return p

    def manage(self, pos, price, liq=100000.0, now=NOW, saf=None):
        book = {"positions": {"base:TOK": pos}, "days": {}, "traded": {}}
        md = {("base", "TOK"): pair(chain="base", dex="uniswap", price_usd=price, liquidity_usd=liq)}
        acts = []
        with mock.patch.object(sn(), "market_data", return_value=md), \
                mock.patch.object(sn(), "safety", return_value=saf or {"ok": True, "verdict": "SAFE", "reasons": []}):
            sn().manage(book, self.s(), config.load_config(), mc.ts(now), acts)
        return book, acts

    def trades(self):
        return state.read_jsonl("sniper/trades.jsonl")

    def test_stop(self):
        config.ensure_home()
        book, acts = self.manage(self.position(), 0.70)
        self.assertEqual(book["positions"], {})
        self.assertIn("stop", self.trades()[-1]["exit_reason"])

    def test_take_half_then_trail(self):
        config.ensure_home()
        book, acts = self.manage(self.position(), 1.60)
        pos = book["positions"]["base:TOK"]
        self.assertTrue(pos["sold_part"])
        self.assertAlmostEqual(pos["tokens"], 5.0)
        book, acts = self.manage(pos, 2.00)  # new high
        book, acts = self.manage(book["positions"]["base:TOK"], 1.45)  # 27.5 % under the high
        self.assertEqual(book["positions"], {})
        t = self.trades()[-1]
        self.assertIn("trailing", t["exit_reason"])
        self.assertGreater(t["pnl_usd"], 0)

    def test_liquidity_drained_or_turned_dangerous_sells_at_once(self):
        config.ensure_home()
        book, _ = self.manage(self.position(), 1.05, liq=40000.0)
        self.assertIn("liquidity drained", self.trades()[-1]["exit_reason"])
        rug = {"ok": False, "verdict": "DANGER", "reasons": ["RugCheck marks this token as already rugged"]}
        book, _ = self.manage(self.position(), 1.05, saf=rug)
        self.assertIn("dangerous", self.trades()[-1]["exit_reason"])

    def test_time_stop(self):
        config.ensure_home()
        book, _ = self.manage(self.position(opened_at="2026-10-22T03:00:00Z"), 1.02)
        self.assertIn("time stop", self.trades()[-1]["exit_reason"])


class Cycle(Settings):
    NOW = NOW

    def test_a_paper_trade_from_signal_to_book_and_log(self):
        config.ensure_home()
        cfg = config.load_config()
        p = pair()
        with mock.patch.object(sn(), "discover", return_value=[cand()]), \
                mock.patch.object(sn(), "market_data", return_value={("solana", "MINT"): p}), \
                mock.patch.object(sn(), "safety", return_value={"ok": True, "score": 90, "verdict": "SAFE",
                                                                  "reasons": []}), \
                mock.patch.object(sn(), "roundtrip", return_value={"loss_pct": 2.0, "tokens_raw": 10_000_000,
                                                                     "sol_usd": 150.0, "route": []}), \
                mock.patch.object(sn(), "x_mentions", return_value=3), \
                mock.patch.object(sn(), "track_outcomes", return_value=0):
            res = sn().cycle(cfg, mc.ts(NOW))
            again = sn().cycle(cfg, mc.ts(NOW) + 60)
        self.assertEqual(res["decisions"][0]["action"], "bought")
        self.assertEqual(res["mode"], "paper")
        pos = state.read_json("sniper/book.json")["positions"]["solana:MINT"]
        self.assertEqual((pos["mode"], pos["cost_usd"], pos["tokens_raw"]), ("paper", 10.0, 10_000_000))
        self.assertEqual(again["decisions"][0]["action"], "skipped")  # already holding it
        self.assertEqual(len(state.read_jsonl("sniper/candidates.jsonl")), 2)


class Live(Settings):
    def test_live_needs_every_step(self):
        config.ensure_home()
        cfg = config.load_config()
        self.assertFalse(sn().live_readiness(cfg)[0])
        cfg["sniper"].update(mode="live", live_confirmation=sn().LIVE_PHRASE)
        self.assertFalse(sn().live_readiness(cfg)[0])  # no wallet
        os.environ["SNIPER_SOL_SECRET"] = "x"
        try:
            self.assertTrue(sn().live_readiness(cfg)[0])
            cfg["sniper"]["live_confirmation"] = "i accept meme coin risk"  # not the exact words
            self.assertFalse(sn().live_readiness(cfg)[0])
            cfg["sniper"].update(live_confirmation=sn().LIVE_PHRASE, mode="paper")
            self.assertFalse(sn().live_readiness(cfg)[0])
        finally:
            os.environ.pop("SNIPER_SOL_SECRET", None)

    def test_paper_on_other_chains_even_when_live(self):
        self.assertEqual(sn().LIVE_CHAINS, ("solana",))


class Outcomes(Settings):
    NOW = NOW

    def test_every_judged_candidate_is_followed_for_a_day(self):
        config.ensure_home()
        state.append_jsonl("sniper/candidates.jsonl", {"at": "2026-10-22T08:00:00Z", "key": "solana:A", "price_usd": 1.0,
                                                        "action": "skipped", "reasons": ["safety: x"]})
        state.append_jsonl("sniper/candidates.jsonl", {"at": "2026-10-22T08:00:00Z", "key": "solana:B", "price_usd": 1.0,
                                                        "action": "bought", "strategy": "momentum"})
        md = {("solana", "A"): {"price_usd": 0.05}}  # B is gone: rugged
        with mock.patch.object(sn(), "market_data", return_value=md):
            n = sn().track_outcomes(mc.ts(NOW))
        self.assertEqual(n, 4)  # 15 min and 1 h for both
        rep = sn().report()
        rows = {g.split(" · ")[0]: r for g, r in rep["groups"].items()}
        self.assertEqual(rows["skipped"]["h1"]["median_pct"], -95.0)
        self.assertEqual(rows["bought"]["h1"]["rugged"], 1.0)


class XDiscovery(Settings):
    def test_addresses_in_fresh_posts_become_candidates(self):
        posts = [{"text": "new gem CA: 7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr pump.fun/coin/x", "followers": 1200},
                 {"text": "aping 7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr again", "followers": 300},
                 {"text": "four.meme launch 0x" + "ab" * 20, "followers": 10},
                 {"text": "no address here, just vibes", "followers": 5}]
        from shared.sources import x
        with mock.patch.object(x, "search_recent", return_value=posts):
            found = sn().x_discover(config.load_config())
        self.assertEqual(found[0], {"chain": "solana", "address": "7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr",
                                    "x_posts": 2, "x_followers": 1500})
        self.assertEqual((found[1]["chain"], found[1]["address"]), ("bsc", "0x" + "ab" * 20))

    def test_no_x_token_no_x(self):
        from shared.sources import x
        with mock.patch.object(x, "search_recent", side_effect=x.XUnavailable("no token")):
            self.assertEqual(sn().x_discover(config.load_config()), [])


class BotWallet(Settings):
    def test_new_wallet_saves_the_key_privately_and_shows_only_the_address(self):
        from shared import secrets, solana
        config.ensure_home()
        code, out, err = self.run_tool("trader-sniper", "sniper", ["wallet", "new"])
        self.assertEqual(code, 0, err)
        path = config.trader_home() / "secrets.env"
        self.assertEqual(oct(os.stat(str(path)).st_mode & 0o777), "0o600")
        secret = secrets.get("SNIPER_SOL_SECRET")
        self.assertNotIn(secret, out + err)
        addr = solana.Keypair(secret).pubkey_b58
        self.assertIn(addr, out)
        self.assertEqual(len(solana.b58decode(addr)), 32)
        code, out, err = self.run_tool("trader-sniper", "sniper", ["wallet", "new"])
        self.assertNotEqual(code, 0)  # a funded wallet's key is never overwritten
        self.assertEqual(secrets.get("SNIPER_SOL_SECRET"), secret)


class LiveOrders(Settings):
    NOW = NOW

    def live_cfg(self):
        from shared import solana
        config.ensure_home()
        os.environ["SNIPER_SOL_SECRET"] = solana.b58encode(solana.new_keypair()[0])
        self.addCleanup(os.environ.pop, "SNIPER_SOL_SECRET", None)
        cfg = config.load_config()
        cfg["sniper"].update(mode="live", live_confirmation=sn().LIVE_PHRASE)
        return cfg

    def test_a_wallet_over_its_cap_buys_nothing(self):
        cfg = self.live_cfg()
        mod = sn()
        sent = []
        with mock.patch.object(mod, "_wallet_usd", return_value=500.0), \
                mock.patch.object(mod, "_swap", side_effect=lambda *a, **k: sent.append(a)):
            with self.assertRaises(RuntimeError) as cm:
                mod.buy(cand(), pair(), {"strategy": "momentum", "why": "x", "stop_pct": 25}, {"tokens_raw": 1,
                        "sol_usd": 150.0}, mod.settings(cfg), cfg, mc.ts(NOW))
        self.assertIn("cap", str(cm.exception))
        self.assertEqual(sent, [])

    def test_a_lost_answer_is_looked_up_never_sent_again(self):
        self.live_cfg()
        mod = sn()
        from shared import solana
        calls = []

        def boom(*a, **k):
            calls.append(1)
            raise solana.TransportError("timed out", signature="SIG1")
        rpc = mock.Mock()
        rpc.confirm.return_value = "confirmed"
        with mock.patch.object(solana, "swap", side_effect=boom), mock.patch.object(mod, "_rpc", return_value=rpc):
            res = mod._swap("A", "B", 100, 300, 1000)
        self.assertEqual((res["signature"], len(calls)), ("SIG1", 1))
        rpc.confirm.return_value = "timeout"
        with mock.patch.object(solana, "swap", side_effect=boom), mock.patch.object(mod, "_rpc", return_value=rpc):
            with self.assertRaises(RuntimeError):
                mod._swap("A", "B", 100, 300, 1000)

    def test_a_live_sale_never_sells_more_than_the_wallet_holds(self):
        cfg = self.live_cfg()
        mod = sn()
        rpc = mock.Mock()
        rpc.get_token_balance.return_value = (0.4, 400, 6)
        swaps = []
        pos = {"mode": "live", "address": "MINT", "tokens_raw": 1000, "symbol": "FROG"}
        with mock.patch.object(mod, "_rpc", return_value=rpc), \
                mock.patch.object(mod, "_swap", side_effect=lambda i, o, amt, *a: swaps.append(amt) or
                                  {"signature": "S", "status": "confirmed", "quote": {"outAmount": "1000000"}}), \
                mock.patch.object(mod, "sol_usd", return_value=150.0):
            mod.sell(pos, 0.5, "take profit", mod.settings(cfg), cfg, mc.ts(NOW), 20.0)
            mod.sell(pos, 1.0, "stop", mod.settings(cfg), cfg, mc.ts(NOW), 20.0)
        self.assertEqual(swaps, [400, 400])  # half of 1,000 would be 500 — the wallet holds 400

    def test_a_live_sale_sells_only_what_its_own_buys_brought_in(self):
        cfg = self.live_cfg()
        mod = sn()
        rpc = mock.Mock()
        rpc.get_token_balance.return_value = (5.0, 5000, 3)  # the wallet holds more of it than the bot bought
        swaps = []
        with mock.patch.object(mod, "_rpc", return_value=rpc), \
                mock.patch.object(mod, "_swap", side_effect=lambda i, o, amt, *a, **k: swaps.append(amt) or
                                  {"signature": "S", "status": "confirmed", "quote": {"outAmount": "1000000"}}), \
                mock.patch.object(mod, "sol_usd", side_effect=http.SourceError("jupiter", "down")):
            fill = mod.sell({"mode": "live", "address": "MINT", "tokens_raw": 1000, "symbol": "FROG"}, 1.0, "stop",
                            mod.settings(cfg), cfg, mc.ts(NOW), 7.5)
        self.assertEqual(swaps, [1000])
        # the SOL price is asked before the sale; without it the quote's value stands — nothing after a confirmed
        # sale may fail its bookkeeping
        self.assertEqual((fill["usd"], fill["sold_raw"]), (7.5, 1000))

    def test_an_answer_that_may_have_been_broadcast_is_looked_up(self):
        self.live_cfg()
        mod = sn()
        from shared import solana
        rpc = mock.Mock()
        rpc.confirm.return_value = "confirmed"
        with mock.patch.object(solana, "swap", side_effect=solana.SolanaError("returned another signature",
                                                                             signature="SIG2")), \
                mock.patch.object(mod, "_rpc", return_value=rpc):
            self.assertEqual(mod._swap("A", "B", 100, 300, 1000)["signature"], "SIG2")
        rpc.confirm.assert_called_once_with("SIG2")


class LiveBuyIsBookedBeforeItIsSent(Settings):
    """A live buy that was sent must be in the book whatever happens next — or the next cycle buys it again."""
    NOW = NOW

    def setUp(self):
        super().setUp()
        from shared import solana
        config.ensure_home()
        os.environ["SNIPER_SOL_SECRET"] = solana.b58encode(solana.new_keypair()[0])
        self.addCleanup(os.environ.pop, "SNIPER_SOL_SECRET", None)
        self.cfg = config.load_config()
        self.cfg["sniper"].update(mode="live", live_confirmation=sn().LIVE_PHRASE)
        self.rpc = mock.Mock()
        self.rpc.get_token_balance.return_value = (0.0, 250, 6)  # dust of it from before: not ours
        self.rpc.signature_status.return_value = None
        self.sent = []

    def fake_swap(self, i, o, amt, slip, prio, before_send=None):
        before_send("SIG%d" % (len(self.sent) + 1), {})
        self.sent.append(amt)
        raise RuntimeError("swap not confirmed: timeout")  # the answer is lost after the send

    def cycle(self, at):
        mod = sn()
        with mock.patch.object(mod, "discover", return_value=[cand()]), \
                mock.patch.object(mod, "market_data", return_value={("solana", "MINT"): pair()}), \
                mock.patch.object(mod, "safety", return_value={"ok": True, "score": 90, "verdict": "SAFE",
                                                                 "reasons": []}), \
                mock.patch.object(mod, "roundtrip", return_value={"loss_pct": 2.0, "tokens_raw": 10_000_000,
                                                                    "sol_usd": 150.0, "route": []}), \
                mock.patch.object(mod, "x_mentions", return_value=None), \
                mock.patch.object(mod, "track_outcomes", return_value=0), \
                mock.patch.object(mod, "value_now", return_value=(10.0, 1e-6)), \
                mock.patch.object(mod, "_wallet_usd", return_value=50.0), \
                mock.patch.object(mod, "_rpc", return_value=self.rpc), \
                mock.patch.object(mod, "_swap", side_effect=self.fake_swap):
            return mod.cycle(self.cfg, mc.ts(NOW) + at)

    def book(self):
        return state.read_json("sniper/book.json")

    def test_a_lost_answer_is_settled_from_the_wallet_never_bought_again(self):
        first = self.cycle(0)
        self.assertEqual(first["decisions"][0]["action"], "sent")
        pos = self.book()["positions"]["solana:MINT"]
        self.assertEqual((pos["status"], pos["buy_tx"], pos["pre_raw"]), ("unconfirmed", "SIG1", 250))
        self.assertEqual(self.book()["days"][NOW[:10]]["trades"], 1)
        for at in (45, 90):
            res = self.cycle(at)
            self.assertEqual(res["decisions"][0]["reasons"], ["already holding it"])
        self.assertEqual(len(self.sent), 1)
        self.rpc.get_token_balance.return_value = (5.0, 5_000_250, 6)  # it landed
        res = self.cycle(135)
        pos = self.book()["positions"]["solana:MINT"]
        self.assertEqual((pos["status"], pos["tokens_raw"]), ("open", 5_000_000))  # only what arrived on top
        self.assertAlmostEqual(pos["entry_price"], 10.0 / 5_000_000)
        self.assertEqual(pos["peak_price"], pos["entry_price"])
        self.assertIn("went through", " ".join(res["actions"]))
        self.assertEqual(len(self.sent), 1)

    def test_the_book_has_it_before_it_is_sent(self):
        def dies(i, o, amt, slip, prio, before_send=None):
            before_send("SIG1", {})
            self.sent.append(amt)
            raise KeyboardInterrupt  # the process is stopped in the middle of the send
        self.fake_swap = dies
        with self.assertRaises(KeyboardInterrupt):
            self.cycle(0)
        pos = self.book()["positions"]["solana:MINT"]
        self.assertEqual((pos["status"], pos["buy_tx"]), ("sending", "SIG1"))
        self.fake_swap = lambda *a, **k: self.fail("sent again")
        self.cycle(45)  # settled from the wallet, never sent again
        self.assertEqual(len(self.sent), 1)

    def test_a_buy_that_never_landed_leaves_the_book_and_is_not_retried_today(self):
        self.cycle(0)
        self.cycle(60)  # too early to tell: the transaction could still land
        self.assertIn("solana:MINT", self.book()["positions"])
        res = self.cycle(200)  # its blockhash has expired and the cluster never saw it
        self.assertNotIn("solana:MINT", self.book()["positions"])
        self.assertIn("never went through", " ".join(res["actions"]))
        self.assertEqual(res["decisions"][0]["reasons"], ["traded in the last 24 h"])
        self.assertEqual(len(self.sent), 1)

    def test_a_failed_transaction_is_settled_at_once(self):
        self.cycle(0)
        self.rpc.signature_status.return_value = 'failed: {"InstructionError":[2,{"Custom":6001}]}'
        self.cycle(45)
        self.assertNotIn("solana:MINT", self.book()["positions"])

    def test_nothing_sent_nothing_booked(self):
        def no_route(*a, **k):
            raise http.SourceError("jupiter", "swap: HTTP 400")  # failed before signing: nothing left the machine
        self.fake_swap = no_route
        res = self.cycle(0)
        self.assertEqual(res["decisions"][0]["action"], "error")
        self.assertEqual((self.book() or {}).get("positions", {}), {})


class KillSwitch(Settings):
    NOW = NOW

    def setUp(self):
        super().setUp()
        config.ensure_home()
        config.update_file("config.json", {"sniper": {"enabled": True}})
        base = {"chain": "solana", "dex": "pumpswap", "strategy": "momentum", "opened_at": NOW, "entry_price": 1e-6,
                "cost_usd": 10.0, "stop_pct": 27.0, "peak_price": 1e-6, "mode": "paper", "price_unit": "raw",
                "tokens_raw": 10_000_000, "url": ""}
        state.write_json("sniper/book.json", {"positions": {
            "solana:A": dict(base, address="A", symbol="A"), "solana:B": dict(base, address="B", symbol="B")},
            "days": {}, "traded": {}})

    def kill(self, fail_on=()):
        mod = sn()

        def fake_sell(pos, part, reason, *a):
            if pos["address"] in fail_on:
                raise RuntimeError("swap not confirmed: timeout")
            return {"usd": 9.0, "part": part, "reason": reason, "at": NOW}
        with mock.patch.object(mod, "market_data", return_value={}), \
                mock.patch.object(mod, "value_now", return_value=(9.0, 9e-7)), \
                mock.patch.object(mod, "sell", side_effect=fake_sell):
            return self.run_tool("trader-sniper", "sniper", ["kill"])

    def test_off_first_then_each_sale_on_its_own(self):
        code, out, _ = self.kill(fail_on=("B",))
        self.assertEqual(code, 1)
        self.assertFalse(config.load_config()["sniper"]["enabled"])
        self.assertEqual(list(state.read_json("sniper/book.json")["positions"]), ["solana:B"])
        self.assertIn("B: sale failed", out)
        code, out, _ = self.kill()
        self.assertEqual(code, 0)
        self.assertEqual(state.read_json("sniper/book.json")["positions"], {})
        self.assertEqual([t["symbol"] for t in state.read_jsonl("sniper/trades.jsonl")], ["A", "B"])  # A once

    def test_a_running_loop_buys_nothing_after_the_switch(self):
        config.update_file("config.json", {"sniper": {"enabled": False}})  # the kill switch, mid-cycle
        cfg = config.load_config()
        cfg["sniper"]["enabled"] = True  # what the loop read when the cycle began
        mod = sn()
        with mock.patch.object(mod, "manage"), \
                mock.patch.object(mod, "discover", return_value=[cand(address="C")]), \
                mock.patch.object(mod, "market_data", return_value={("solana", "C"): pair()}), \
                mock.patch.object(mod, "safety", return_value={"ok": True, "score": 90, "verdict": "SAFE",
                                                                 "reasons": []}), \
                mock.patch.object(mod, "roundtrip", return_value={"loss_pct": 2.0, "tokens_raw": 10_000_000,
                                                                    "sol_usd": 150.0, "route": []}), \
                mock.patch.object(mod, "x_mentions", return_value=None), \
                mock.patch.object(mod, "track_outcomes", return_value=0), \
                mock.patch.object(mod, "buy") as buy:
            res = mod.cycle(cfg, mc.ts(NOW))
        self.assertEqual(res["decisions"][0]["reasons"], ["the sniper was switched off"])
        buy.assert_not_called()


class RunLoop(Settings):
    NOW = NOW

    def test_one_failed_cycle_does_not_end_the_loop(self):
        config.ensure_home()
        config.update_file("config.json", {"sniper": {"enabled": True}})
        mod = sn()
        ok = {"at": NOW, "mode": "paper", "actions": [], "decisions": [], "notes": [], "open": 0}
        with mock.patch.object(mod, "cycle", side_effect=[state.LockTimeout("book busy"), ok]) as cyc, \
                mock.patch.object(mod.time, "sleep"):
            code, out, _ = self.run_tool("trader-sniper", "sniper", ["run", "--loop", "--max-cycles", "2"])
        self.assertEqual((code, cyc.call_count), (0, 2))
        self.assertIn("cycle failed", out)


class ReviewedExits(Settings):
    NOW = NOW

    def raw_position(self, **kw):
        p = {"chain": "solana", "address": "MINT", "symbol": "FROG", "dex": "pumpswap", "strategy": "momentum",
             "opened_at": NOW, "entry_price": 1e-6, "cost_usd": 10.0, "stop_pct": 27.0, "peak_price": 1e-6,
             "mode": "paper", "price_unit": "raw", "tokens_raw": 10_000_000, "url": "", "entry_liquidity": 80000.0}
        p.update(kw)
        return p

    def manage(self, book, quote, at=600, md=None):
        mod = sn()
        acts = []
        with mock.patch.object(mod, "market_data", return_value={("solana", "MINT"): pair()} if md is None else md), \
                mock.patch.object(mod, "sol_usd", return_value=150.0), \
                mock.patch.object(mod, "safety", return_value={"ok": True, "verdict": "SAFE", "reasons": []}), \
                mock.patch.object(mod.jupiter, "quote", side_effect=quote):
            mod.manage(book, self.s(), config.load_config(), mc.ts(NOW) + at, acts)
        return acts

    @staticmethod
    def worth(usd_for_all, raw=10_000_000):
        return lambda a, b, amt, slip: {"out_raw": int(usd_for_all * amt / raw / 150.0 * 1e9), "in_raw": amt,
                                        "price_impact_pct": 0, "route": []}

    def test_after_taking_profit_a_new_high_is_not_a_trailing_stop(self):
        config.ensure_home()
        mod = sn()
        pos = mod.buy(cand(), pair(), {"strategy": "momentum", "why": "x", "stop_pct": 25},
                      {"tokens_raw": 10_000_000, "sol_usd": 150.0, "loss_pct": 2.0}, self.s(), config.load_config(),
                      mc.ts(NOW))
        self.assertEqual(pos["peak_price"], pos["entry_price"])  # per raw unit, like every price it is compared with
        self.assertEqual(pos["stop_pct"], 27.0)  # the strategy's 25 % plus the 2 % the round trip costs
        book = {"positions": {"solana:MINT": pos}, "days": {}, "traded": {}}
        self.manage(book, self.worth(16.0))  # +60 %: half is sold
        self.assertTrue(book["positions"]["solana:MINT"]["sold_part"])
        self.manage(book, self.worth(17.0), at=660)  # +70 %, higher still
        self.assertIn("solana:MINT", book["positions"])

    def test_no_answer_from_jupiter_is_no_price_not_a_zero(self):
        config.ensure_home()
        book = {"positions": {"solana:MINT": self.raw_position()}, "days": {}, "traded": {}}
        self.manage(book, http.SourceError("jupiter", "HTTP 429", 429))
        self.assertIn("solana:MINT", book["positions"])
        jup = sn().jupiter
        acts = self.manage(book, jup.NoRoute("jupiter", "no route"))  # once can be Jupiter's hiccup
        self.assertIn("solana:MINT", book["positions"])
        self.assertIn("once more", " ".join(acts))
        self.manage(book, jup.NoRoute("jupiter", "no route"))  # twice in a row is the token
        self.assertEqual(book["positions"], {})
        self.assertIn("no way to sell", state.read_jsonl("sniper/trades.jsonl")[-1]["exit_reason"])

    def test_a_paper_pool_without_market_data_waits_then_counts_as_gone(self):
        config.ensure_home()
        pos = {"chain": "base", "address": "TOK", "symbol": "TOK", "dex": "uniswap", "strategy": "momentum",
               "opened_at": NOW, "entry_price": 1.0, "cost_usd": 10.0, "stop_pct": 27.0, "peak_price": 1.0,
               "entry_liquidity": 100000.0, "mode": "paper", "price_unit": "usd", "tokens": 10.0, "url": ""}
        book = {"positions": {"base:TOK": pos}, "days": {}, "traded": {}}
        for i in range(sn().GONE_AFTER - 1):
            self.manage(book, None, at=60 * i, md={})
        self.assertIn("base:TOK", book["positions"])
        self.manage(book, None, at=900, md={})
        self.assertEqual(book["positions"], {})

    def test_every_sale_is_on_disk_at_once(self):
        config.ensure_home()
        book = {"positions": {"solana:MINT": self.raw_position()}, "days": {}, "traded": {}}
        self.manage(book, self.worth(5.0))  # −50 %: stop
        self.assertEqual(state.read_json("sniper/book.json")["positions"], {})


class ReviewedBudget(Settings):
    NOW = NOW

    def test_the_daily_limit_counts_open_losses_and_the_next_trades_risk(self):
        s, now = self.s(), mc.ts(NOW)
        # $30 a day; the next trade can lose $10 × (25 % stop + 8 % round trip) = $3.30
        book = {"positions": {"solana:X": {"cost_usd": 10.0, "value_usd": 4.0}},
                "days": {NOW[:10]: {"trades": 3, "pnl_usd": -20.0}}, "traded": {}}
        self.assertEqual(sn().budget_refusal(book, s, now, "solana:A"), "")  # 20 + 6 + 3.30 = 29.30
        book["positions"]["solana:X"]["value_usd"] = 3.0  # 20 + 7 + 3.30 = 30.30
        self.assertIn("open positions included", sn().budget_refusal(book, s, now, "solana:A"))

    def test_a_stop_inside_the_noise_is_no_trade(self):
        config.ensure_home()
        mod = sn()
        with mock.patch.object(mod, "manage"), \
                mock.patch.object(mod, "discover", return_value=[cand()]), \
                mock.patch.object(mod, "market_data", return_value={("solana", "MINT"): pair()}), \
                mock.patch.object(mod, "safety", return_value={"ok": True, "score": 90, "verdict": "SAFE",
                                                                 "reasons": []}), \
                mock.patch.object(mod, "roundtrip", return_value={"loss_pct": 2.0, "tokens_raw": 10_000_000,
                                                                    "sol_usd": 150.0, "route": []}), \
                mock.patch.object(mod, "signal", return_value={"strategy": "pullback", "why": "x", "stop_pct": 0.4}), \
                mock.patch.object(mod, "x_mentions", return_value=None), \
                mock.patch.object(mod, "track_outcomes", return_value=0):
            res = mod.cycle(config.load_config(), mc.ts(NOW))
        self.assertEqual(res["decisions"][0]["action"], "skipped")
        self.assertIn("wiggle", res["decisions"][0]["reasons"][0])

    def test_the_key_file_must_be_private(self):
        config.ensure_home()
        path = config.trader_home() / "secrets.env"
        path.write_text("SNIPER_SOL_SECRET=x\n", encoding="ascii")
        os.chmod(str(path), 0o644)
        cfg = config.load_config()
        cfg["sniper"].update(mode="live", live_confirmation=sn().LIVE_PHRASE)
        ok, missing = sn().live_readiness(cfg)
        self.assertFalse(ok)
        self.assertIn("private", " ".join(missing))
        os.chmod(str(path), 0o600)
        self.assertTrue(sn().live_readiness(cfg)[0])
