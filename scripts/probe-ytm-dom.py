#!/usr/bin/env python3
"""CDP probe: inspect music.youtube.com main world from the ytmView target."""
import asyncio
import json
import sys
import urllib.request

import websockets


def get_targets():
    with urllib.request.urlopen("http://127.0.0.1:9222/json/list", timeout=5) as r:
        return json.load(r)


async def main():
    targets = [t for t in get_targets() if (t.get("url") or "").startswith("https://music.youtube.com")]
    if not targets:
        print("NO YTM TARGET FOUND")
        sys.exit(1)
    ws_url = targets[0]["webSocketDebuggerUrl"]
    print("target:", targets[0]["url"])

    async with websockets.connect(ws_url, max_size=20 * 1024 * 1024) as ws:
        msg_id = 0

        async def evaluate(expr):
            nonlocal msg_id
            msg_id += 1
            await ws.send(json.dumps({
                "id": msg_id,
                "method": "Runtime.evaluate",
                "params": {"expression": expr, "returnByValue": True, "awaitPromise": True}
            }))
            while True:
                resp = json.loads(await ws.recv())
                if resp.get("id") == msg_id:
                    result = resp.get("result", {}).get("result", {})
                    if "exceptionDetails" in resp.get("result", {}):
                        return {"__exception__": str(resp["result"]["exceptionDetails"].get("exception", {}).get("description", ""))[:300]}
                    return result.get("value", result.get("description", str(result)))

        probes = [
            ("el exists", '!!document.querySelector("ytmusic-app-layout>ytmusic-player-bar")'),
            ("el tag", '(document.querySelector("ytmusic-app-layout>ytmusic-player-bar")||{}).tagName||"none"'),
            ("el has playerApi", '!!(document.querySelector("ytmusic-app-layout>ytmusic-player-bar")||{}).playerApi'),
            ("el props", 'Object.keys(document.querySelector("ytmusic-app-layout>ytmusic-player-bar")||{}).filter(k=>k.toLowerCase().includes("api")||k.toLowerCase().includes("player")).join(",")||"no-match"'),
            ("proto playerApi", '!!(document.querySelector("ytmusic-app-layout>ytmusic-player-bar")||{}).__proto__.playerApi'),
            ("isReady() direct", '(function(){var el=document.querySelector("ytmusic-app-layout>ytmusic-player-bar");try{return el&&el.playerApi?String(el.playerApi.isReady()):"no-playerApi"}catch(e){return "throw: "+e.message}})()'),
            ("readyState getter?", '(function(){var el=document.querySelector("ytmusic-app-layout>ytmusic-player-bar");if(!el)return "no-el";var d=Object.getOwnPropertyDescriptor(el,"playerApi");return d?("own: get="+!!d.get+" val="+!!d.value):"no own prop"})()'),
            ("readyState getter proto", '(function(){var el=document.querySelector("ytmusic-app-layout>ytmusic-player-bar");if(!el)return "no-el";var d=Object.getOwnPropertyDescriptor(el.__proto__,"playerApi");return d?("proto: get="+!!d.get+" val="+!!d.value):"no proto prop"})()'),
            ("app-layout ready", '(function(){var l=document.querySelector("ytmusic-app-layout");return l?String(l.readyState||"no-prop"):"no-layout"})()'),
            ("page title", 'document.title'),
            ("polymer ver", '(window.Polymer&&window.Polymer.version)||"no-polymer"'),
        ]
        for name, expr in probes:
            val = await evaluate(expr)
            print(f"{name:24} -> {val}")


asyncio.run(main())
