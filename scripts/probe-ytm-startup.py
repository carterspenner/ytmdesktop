#!/usr/bin/env python3
"""One-shot startup probe: sample ytmView state every 2s for 45s, capture console + network failures."""
import asyncio
import json
import time
import urllib.request

import websockets


def get_targets():
    with urllib.request.urlopen("http://127.0.0.1:9222/json/list", timeout=5) as r:
        return json.load(r)


SAMPLE_EXPR = """(function(){
  var el = document.querySelector("ytmusic-app-layout>ytmusic-player-bar");
  return {
    readyState: document.readyState,
    title: document.title.slice(0, 30),
    bar: !!el,
    playerApi: !!(el && el.playerApi),
    isReady: (function(){ try { return el && el.playerApi ? el.playerApi.isReady() : null } catch(e){ return "THROW:"+e.message } })(),
    hook: !!window.__YTMD_HOOK__,
    polymer: !!window.Polymer
  };
})()"""


async def main():
    # Wait for the ytmView target to appear (page navigates right after launch)
    target = None
    for _ in range(30):
        try:
            targets = [t for t in get_targets() if (t.get("url") or "").startswith("https://music.youtube.com")]
            if targets:
                target = targets[0]
                break
        except Exception:
            pass
        time.sleep(1)
    if not target:
        print("NO YTM TARGET")
        return
    print(f"target acquired at t+{time.strftime('%H:%M:%S')} url={target['url']}")

    async with websockets.connect(target["webSocketDebuggerUrl"], max_size=20 * 1024 * 1024) as ws:
        msg_id = 0
        console_lines = []
        failed_requests = []
        stop_at = time.monotonic() + 47

        async def evaluate(expr):
            nonlocal msg_id
            msg_id += 1
            mid = msg_id
            await ws.send(json.dumps({"id": mid, "method": "Runtime.evaluate",
                                      "params": {"expression": expr, "returnByValue": True}}))
            return mid

        pending_evals = {}
        first_eval = await evaluate(SAMPLE_EXPR)
        pending_evals[first_eval] = 0
        sample_n = 0

        while time.monotonic() < stop_at:
            try:
                raw = await asyncio.wait_for(ws.recv(), timeout=2.0)
            except asyncio.TimeoutError:
                sample_n += 1
                mid = await evaluate(SAMPLE_EXPR)
                pending_evals[mid] = sample_n
                continue

            msg = json.loads(raw)
            method = msg.get("method", "")

            if msg.get("id") in pending_evals:
                n = pending_evals.pop(msg["id"])
                r = msg.get("result", {})
                if "exceptionDetails" in r:
                    val = "EXC " + str(r["exceptionDetails"].get("exception", {}).get("description", ""))[:80]
                else:
                    v = r.get("result", {}).get("value")
                    val = json.dumps(v) if v is not None else str(r.get("result", {}).get("description"))
                t = time.strftime("%H:%M:%S")
                print(f"[{t}] sample#{n:02}: {val}")

            elif method == "Runtime.consoleAPICalled":
                args = msg["params"].get("args", [])
                text = " ".join(str(a.get("value", a.get("description", "")))[:60] for a in args)
                src = msg["params"].get("stackTrace", {}).get("callFrames", [{}])[0].get("url", "")[:40]
                line = f"[{time.strftime('%H:%M:%S')}] console.{msg['params']['type']}: {text} ({src})"
                console_lines.append(line)
                if len(console_lines) <= 40:
                    print("  " + line)

            elif method == "Network.loadingFailed":
                params = msg["params"]
                failed_requests.append((params.get("errorText"), params.get("type")))

        print(f"\n=== failed network requests: {len(failed_requests)} ===")
        from collections import Counter
        for (err, typ), cnt in Counter(failed_requests).most_common(10):
            print(f"  {cnt}x {err} ({typ})")
        print(f"\n=== total console lines captured: {len(console_lines)} (first 40 printed above if any) ===")


asyncio.run(main())
