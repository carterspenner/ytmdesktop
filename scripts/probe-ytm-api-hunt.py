#!/usr/bin/env python3
"""Probe 2: where did playerApi go? Scan candidates, element props, proto chain."""
import asyncio
import json
import time
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
                        return "EXC: " + str(r["exceptionDetails"].get("exception", {}).get("description", ""))[:200]
                    v = r.get("result", {})
                    return v.get("value", v.get("description", str(v)))

        probes = [
            ("player-bar count", 'document.querySelectorAll("ytmusic-player-bar").length'),
            ("bars+parents", 'Array.from(document.querySelectorAll("ytmusic-player-bar")).map(e=>e.parentElement.tagName+">"+e.tagName+JSON.stringify({cls:e.className.slice(0,30)})).join(" || ")'),
            ("app present", '!!document.querySelector("ytmusic-app")'),
            ("app-layout present", '!!document.querySelector("ytmusic-app-layout")'),
            ("bar shadowRoot", '!!(document.querySelector("ytmusic-app-layout>ytmusic-player-bar")||{shadowRoot:0}).shadowRoot'),
            ("bar constructor", '(document.querySelector("ytmusic-app-layout>ytmusic-player-bar")||{}).constructor?.name'),
            ("bar own props", 'Object.getOwnPropertyNames(document.querySelector("ytmusic-app-layout>ytmusic-player-bar")||{}).slice(0,50).join(",")'),
            ("bar proto props", '(function(){var el=document.querySelector("ytmusic-app-layout>ytmusic-player-bar");if(!el)return "no-el";var p=el.__proto__;return Object.getOwnPropertyNames(p).filter(k=>/api|player|Api/i.test(k)).join(",")||"none-matching"})()'),
            ("proto chain", '(function(){var el=document.querySelector("ytmusic-app-layout>ytmusic-player-bar");if(!el)return "no-el";var names=[];var p=el;for(var i=0;i<5&&p;i++){names.push((p.constructor&&p.constructor.name||"?")+"["+Object.getOwnPropertyNames(p).length+"]");p=p.__proto__}return names.join(" -> ")})()'),
            ("any node with playerApi", '(function(){var hits=[];var all=document.querySelectorAll("*");for(var i=0;i<all.length&&hits.length<8;i++){var e=all[i];try{if(e.playerApi!==undefined){hits.push(e.tagName+(e.id?"#"+e.id:"")+(e.className?"."+String(e.className).split(" ")[0]:""))}}catch(err){}}return hits.length?hits.join(", "):"NONE in "+all.length+" elements"})()'),
            ("hook keys", 'Object.keys(window.__YTMD_HOOK__||{}).join(",")'),
            ("store dispatch test", '(function(){try{window.__YTMD_HOOK__.ytmStore.getState ? "getState OK" : "no getState"}catch(e){return "throw:"+e.message}})()'),
            ("ytInitialData?", '!!(window.ytInitialData||window.ytcfg||window.ytplayer)'),
            ("ytcfg keys", 'window.ytcfg ? Object.keys(window.ytcfg.data_||{}).slice(0,10).join(",") : "no ytcfg"'),
        ]
        for name, expr in probes:
            val = await evaluate(expr)
            print(f"{name:24} -> {str(val)[:220]}")


asyncio.run(main())
