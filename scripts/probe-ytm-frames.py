#!/usr/bin/env python3
"""CDP probe 2: frame tree + document state of the ytmView target."""
import asyncio
import json
import urllib.request

import websockets


def get_targets():
    with urllib.request.urlopen("http://127.0.0.1:9222/json/list", timeout=5) as r:
        return json.load(r)


async def main():
    targets = [t for t in get_targets() if (t.get("url") or "").startswith("https://music.youtube.com")]
    ws_url = targets[0]["webSocketDebuggerUrl"]
    async with websockets.connect(ws_url, max_size=20 * 1024 * 1024) as ws:
        msg_id = 0
        pending = {}

        async def send(method, params=None):
            nonlocal msg_id
            msg_id += 1
            await ws.send(json.dumps({"id": msg_id, "method": method, "params": params or {}}))
            return msg_id

        async def evaluate(expr):
            mid = await send("Runtime.evaluate", {"expression": expr, "returnByValue": True, "awaitPromise": True})
            while True:
                resp = json.loads(await ws.recv())
                if resp.get("id") == mid:
                    r = resp.get("result", {})
                    if "exceptionDetails" in r:
                        return "EXC: " + str(r["exceptionDetails"].get("exception", {}).get("description", ""))[:200]
                    v = r.get("result", {})
                    return v.get("value", v.get("description", str(v)))

        # Frame tree first
        mid = await send("Page.getFrameTree")
        frame_tree = None
        while frame_tree is None:
            resp = json.loads(await ws.recv())
            if resp.get("id") == mid:
                frame_tree = resp["result"]["frameTree"]

        def walk(f, depth=0):
            fr = f["frame"]
            print("  " * depth + f"frame id={fr['id'][:12]} url={fr.get('url','')[:70]}")
            for c in f.get("childFrames", []):
                walk(c, depth + 1)

        walk(frame_tree)

        for expr in [
            "location.href",
            "document.readyState",
            "document.title",
            "document.body ? document.body.children.length : 'no-body'",
            "document.documentElement ? document.documentElement.outerHTML.length : 'no-docEl'",
            "!!window.Polymer",
            "Object.keys(window).filter(k=>k.startsWith('yt')).join(',')",
        ]:
            print(f"{expr[:60]:62} -> {await evaluate(expr)}")


asyncio.run(main())
