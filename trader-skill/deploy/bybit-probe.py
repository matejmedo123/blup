#!/usr/bin/env python3
"""Which Bybit host knows which key? An answer that does not depend on the bot's own Bybit code.

    ( set -a; . /etc/trader/trader.env; set +a; python3 deploy/bybit-probe.py )

For BYBIT_LIVE_*, BYBIT_TESTNET_* and BYBIT_DEMO_* (whichever is set) it asks every Bybit EU and global host (live,
testnet, demo) one read-only question (open spot orders) and prints each host's raw answer, plus this server's public IP. Only the
first and last 4 characters of a key are printed, never a secret. retCode 0 = the host knows the key; 10003 = it
does not; 10004 = the secret is wrong; 10010 = the key is bound to another IP; 10002 = this server's clock is off.
"""
import hashlib, hmac, http.client, os, time, urllib.request
try:
    print("IP servera:", urllib.request.urlopen("https://api.ipify.org", timeout=10).read().decode())
except Exception as e:
    print("IP servera: ?", e)
for name in ("BYBIT_LIVE", "BYBIT_TESTNET", "BYBIT_DEMO"):
    key, secret = os.environ.get(name + "_KEY", ""), os.environ.get(name + "_SECRET", "")
    if not key:
        continue
    print("%s kluc %s...%s" % (name, key[:4], key[-4:]))
    for host in ("api.bybit.eu", "api-testnet.bybit.eu", "api-testnet.bybit.com", "api-demo.bybit.eu",
                 "api-demo.bybit.com"):
        ts, rw, q = str(int(time.time() * 1000)), "5000", "category=spot&limit=1"
        sign = hmac.new(secret.encode(), (ts + key + rw + q).encode(), hashlib.sha256).hexdigest()
        try:
            c = http.client.HTTPSConnection(host, timeout=15)
            c.putrequest("GET", "/v5/order/realtime?" + q)
            for h, v in (("X-BAPI-API-KEY", key), ("X-BAPI-TIMESTAMP", ts), ("X-BAPI-RECV-WINDOW", rw), ("X-BAPI-SIGN", sign)):
                c.putheader(h, v)
            c.endheaders()
            r = c.getresponse()
            body = r.read().decode(errors="replace").replace("\n", " ")[:150]
            print("  %-21s HTTP %s  %s" % (host, r.status, body))
        except Exception as e:
            print("  %-21s %s" % (host, e))
