#!/usr/bin/env python3
"""Probe 4: verify inst.playerApi is the live API; compare old bar vs new top-player-bar."""
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
            ("old inst.playerApi type", '(function(){var el=document.querySelector("ytmusic-app-layout>ytmusic-player-bar");return el&&el.inst&&el.inst.playerApi?typeof el.inst.playerApi:"missing"})()'),
            ("old inst.playerApi.isReady()", '(function(){try{var el=document.querySelector("ytmusic-app-layout>ytmusic-player-bar");return String(el.inst.playerApi.isReady())}catch(e){return "throw:"+e.message}})()'),
            ("old inst.playerApi methods", '(function(){try{var a=document.querySelector("ytmusic-app-layout>ytmusic-player-bar").inst.playerApi;var want=["playVideo","pauseVideo","nextVideo","previousVideo","getVolume","setVolume","getPlayerResponse","getPlaylistId","getVideoData","addEventListener","seekTo","loadVideoById"];return want.map(m=>m+":"+(typeof a[m])).join(" ")}catch(e){return "throw:"+e.message}})()'),
            ("old api getVolume", '(function(){try{return String(document.querySelector("ytmusic-app-layout>ytmusic-player-bar").inst.playerApi.getVolume())}catch(e){return "throw:"+e.message}})()'),
            ("old api getPlayerResponse", '(function(){try{var pr=document.querySelector("ytmusic-app-layout>ytmusic-player-bar").inst.playerApi.getPlayerResponse();return pr?("videoId="+(pr.videoDetails&&pr.videoDetails.videoId||"none")):"null"}catch(e){return "throw:"+e.message}})()'),
            ("new bar inst.playerApi", '(function(){var el=document.querySelector("div>ytmusic-player-bar.top-player-bar");if(!el||!el.inst)return "no-new-inst";return el.inst.playerApi?("exists, isReady="+String(el.inst.playerApi.isReady())):"no playerApi on new inst"})()'),
            ("new api getVolume", '(function(){try{return String(document.querySelector("div>ytmusic-player-bar.top-player-bar").inst.playerApi.getVolume())}catch(e){return "throw:"+e.message}})()'),
            ("old api listeners API", '(function(){try{var a=document.querySelector("ytmusic-app-layout>ytmusic-player-bar").inst.playerApi;return "addEventListener="+(typeof a.addEventListener)+" onStateChange props="+Object.keys(a).filter(k=>k.startsWith("on")||k.includes("isten")).slice(0,10).join(",")}catch(e){return "throw:"+e.message}})()'),
            ("video playing now", '(function(){try{var v=document.querySelector("video");return v?("paused="+v.paused+" currentTime="+(v.currentTime||0).toFixed(1)):"no video"}catch(e){return "throw:"+e.message}})()'),
        ]
        for name, expr in probes:
            val = await evaluate(expr)
            print(f"{name:28} -> {str(val)[:280]}")


asyncio.run(main())
