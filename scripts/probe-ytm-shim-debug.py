#!/usr/bin/env python3
"""Probe 5: why didn't the shim land? Inspect customElements, proto descriptor, inst."""
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
                        return "EXC: " + str(r["exceptionDetails"].get("exception", {}).get("description", ""))[:300]
                    v = r.get("result", {})
                    return v.get("value", v.get("description", str(v)))

        probes = [
            ("CE registered?", '(function(){try{return String(!!window.customElements.get("ytmusic-player-bar"))}catch(e){return "throw:"+e.message}})()'),
            ("CE typeof", 'typeof window.customElements'),
            ("proto has playerApi", '(function(){var el=document.querySelector("ytmusic-app-layout>ytmusic-player-bar");if(!el)return "no-el";var p=el.__proto__;var d=Object.getOwnPropertyDescriptor(p,"playerApi");return d?("desc: get="+!!d.get+" shim="+(d.get&&d.get.__ytmdShim)):"no-desc"})()'),
            ("el.playerApi value", '(function(){var el=document.querySelector("ytmusic-app-layout>ytmusic-player-bar");return String(el&&el.playerApi)})()'),
            ("el.inst now", '(function(){var el=document.querySelector("ytmusic-app-layout>ytmusic-player-bar");return el?("inst="+(el.inst?"exists":"undefined")+(el.inst&&el.inst.playerApi?" playerApi=yes":"")):"no-el"})()'),
            ("proto chain len", '(function(){var el=document.querySelector("ytmusic-app-layout>ytmusic-player-bar");if(!el)return "no-el";var c=0,p=el;while(p&&c<10){c++;p=p.__proto__}return String(c)})()'),
            ("shim on chain?", '(function(){var el=document.querySelector("ytmusic-app-layout>ytmusic-player-bar");if(!el)return "no-el";var p=el;while(p){var d=Object.getOwnPropertyDescriptor(p,"playerApi");if(d)return "found on "+(p.constructor&&p.constructor.name)+ " shim="+(d.get&&d.get.__ytmdShim);p=p.__proto__}return "not on any proto level"})()'),
            ("retry manual shim", '(function(){try{var el=document.querySelector("ytmusic-app-layout>ytmusic-player-bar");var proto=el.__proto__;Object.defineProperty(proto,"playerApi",{configurable:true,get:function(){return this.inst?this.inst.playerApi:undefined}});return "defined, now el.playerApi="+String(!!el.playerApi)}catch(e){return "throw:"+e.message}})()'),
        ]
        for name, expr in probes:
            val = await evaluate(expr)
            print(f"{name:22} -> {str(val)[:200]}")


asyncio.run(main())
