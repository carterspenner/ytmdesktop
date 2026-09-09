#!/usr/bin/env python3
"""Probe 3: hunt playerApi in shadow roots, inst, controllerProxy, and the new top-player-bar."""
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

        async def evaluate(expr):
            nonlocal msg_id
            msg_id += 1
            await ws.send(json.dumps({"id": msg_id, "method": "Runtime.evaluate",
                                      "params": {"expression": expr, "returnByValue": True}}))
            while True:
                resp = json.loads(await ws.recv())
                if resp.get("id") == msg_id:
                    r = resp.get("result", {})
                    if "exceptionDetails" in r:
                        return "EXC: " + str(r["exceptionDetails"].get("exception", {}).get("description", ""))[:250]
                    v = r.get("result", {})
                    return v.get("value", v.get("description", str(v)))

        probes = [
            ("old bar .inst keys", '(function(){var el=document.querySelector("ytmusic-app-layout>ytmusic-player-bar");var i=el&&el.inst;if(!i)return "no-inst";return Object.getOwnPropertyNames(i).filter(k=>/api|play|Api|Player/i.test(k)).slice(0,20).join(",")||"no-match ("+Object.getOwnPropertyNames(i).length+" props)"})()'),
            ("old bar controllerProxy", '(function(){var el=document.querySelector("ytmusic-app-layout>ytmusic-player-bar");var c=el&&el.controllerProxy;return c?Object.getOwnPropertyNames(Object.getPrototypeOf(c)).slice(0,30).join(","):"no-controllerProxy"})()'),
            ("new bar shadow", '(function(){var el=document.querySelector("div>ytmusic-player-bar.top-player-bar");if(!el)return "no-new-bar";var sr=el.shadowRoot;return sr?("shadowRoot OPEN, "+sr.querySelectorAll("*").length+" nodes"):"no shadowRoot access"})()'),
            ("shadow scan all roots", '(function(){var found=[];function scan(root,depth){if(depth>4)return;var els=root.querySelectorAll("*");for(var i=0;i<els.length;i++){var e=els[i];if(e.playerApi!==undefined)found.push(e.tagName);if(e.shadowRoot)scan(e.shadowRoot,depth+1)}}scan(document,0);return found.length?found.join(","):"NONE accessible"})()'),
            ("new bar proto api props", '(function(){var el=document.querySelector("div>ytmusic-player-bar.top-player-bar");if(!el)return "no-new-bar";var p=el.__proto__;return Object.getOwnPropertyNames(p).filter(k=>/api|Api/i.test(k)).join(",")||"none"})()'),
            ("new bar own props", '(function(){var el=document.querySelector("div>ytmusic-player-bar.top-player-bar");return el?Object.getOwnPropertyNames(el).slice(0,40).join(","):"none"})()'),
            ("video element", '(function(){var v=document.querySelector("video");return v?("video exists src="+(v.src||v.currentSrc||"no-src").slice(0,40)):"no video el"})()'),
            ("bars visible?", '(function(){function vis(e){var r=e.getBoundingClientRect();return r.width>0&&r.height>0}var a=document.querySelector("ytmusic-app-layout>ytmusic-player-bar");var b=document.querySelector("div>ytmusic-player-bar.top-player-bar");return "old:"+vis(a)+" new:"+(b?vis(b):"none")})()'),
            ("old bar hidden attr", '(function(){var a=document.querySelector("ytmusic-app-layout>ytmusic-player-bar");return a?"display="+getComputedStyle(a).display+" rect="+JSON.stringify(a.getBoundingClientRect()).slice(0,80):"none"})()'),
            ("isReady via store?", '(function(){try{var s=window.__YTMD_HOOK__.ytmStore.getState();var keys=Object.keys(s).slice(0,15);return "store keys: "+keys.join(",")}catch(e){return "throw:"+e.message}})()'),
            ("store player slice", '(function(){try{var s=window.__YTMD_HOOK__.ytmStore.getState();return s.player?("player keys: "+Object.keys(s.player).slice(0,20).join(",")):"no player slice"}catch(e){return "throw:"+e.message}})()'),
        ]
        for name, expr in probes:
            val = await evaluate(expr)
            print(f"{name:26} -> {str(val)[:250]}")


asyncio.run(main())
