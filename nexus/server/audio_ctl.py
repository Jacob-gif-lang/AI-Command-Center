# -*- coding: utf-8 -*-
"""NEXUS 音频控制桥：用 pycaw 枚举/静音/恢复当前正在播放的音频会话。
由 Node 后端 child_process 调用，输出 JSON。
命令：list | mute | unmute | toggle | status
"""
import sys
import json
import os

try:
    from pycaw.pycaw import AudioUtilities, IAudioSessionControl2
except Exception as _e:
    print(json.dumps({"error": "pycaw_unavailable", "detail": str(_e)}, ensure_ascii=False))
    sys.exit(0)

ROOT = os.environ.get("APPDATA") or os.path.expanduser("~")
STATE = os.path.join(ROOT, "Nexus", "audio-state.json")

ACTIVE = 1


def _iter_sessions():
    for s in AudioUtilities.GetAllSessions():
        try:
            yield s
        except Exception:
            pass


def _sid_of(s):
    try:
        ctl = s._ctl.QueryInterface(IAudioSessionControl2)
        return ctl.GetSessionInstanceIdentifier()
    except Exception:
        return None


def sessions():
    out = []
    for s in _iter_sessions():
        try:
            proc = s.Process
            name = proc.name() if proc else ""
            vol = s.SimpleAudioVolume
            out.append({
                "pid": s.ProcessId,
                "name": name,
                "state": int(getattr(s, "State", 0)),
                "muted": bool(vol.GetMute()),
                "volume": round(vol.GetMasterVolume() * 100),
                "sid": _sid_of(s),
                "title": "",
            })
        except Exception:
            pass
    return out


def _save_sids(sids):
    try:
        os.makedirs(os.path.dirname(STATE), exist_ok=True)
        with open(STATE, "w", encoding="utf-8") as f:
            json.dump({"sids": sids}, f)
    except Exception:
        pass


def _load_sids():
    try:
        with open(STATE, encoding="utf-8") as f:
            return json.load(f).get("sids", [])
    except Exception:
        return []


def mute_all():
    sids, names = [], []
    for s in _iter_sessions():
        try:
            if int(getattr(s, "State", 0)) != ACTIVE:
                continue
            vol = s.SimpleAudioVolume
            if vol.GetMute():
                continue
            sid = _sid_of(s)
            vol.SetMute(1, None)
            if sid:
                sids.append(sid)
            p = s.Process
            names.append(p.name() if p else "")
        except Exception:
            pass
    _save_sids(sids)
    return {"ok": True, "action": "muted", "count": len(sids), "names": names}


def unmute():
    wanted = set(_load_sids())
    done, names = [], []
    for s in _iter_sessions():
        sid = _sid_of(s)
        if sid not in wanted:
            continue
        try:
            s.SimpleAudioVolume.SetMute(0, None)
            done.append(sid)
            p = s.Process
            names.append(p.name() if p else "")
        except Exception:
            pass
    _save_sids([])
    return {"ok": True, "action": "unmuted", "count": len(done), "names": names}


def toggle():
    ss = sessions()
    playing_live = [x for x in ss if x["state"] == ACTIVE and not x["muted"]]
    if playing_live:
        return mute_all()
    if _load_sids():
        return unmute()
    return {"ok": True, "action": "none", "count": 0,
            "message": "当前没有正在播放的声音"}


def status():
    ss = sessions()
    return {
        "ok": True,
        "muted": bool(_load_sids()),
        "playing": [x for x in ss if x["state"] == ACTIVE and not x["muted"]],
        "sessions": ss,
    }


def main():
    cmd = (sys.argv[1] if len(sys.argv) > 1 else "status").lower()
    try:
        if cmd == "list":
            result = {"ok": True, "sessions": sessions()}
        elif cmd == "mute":
            result = mute_all()
        elif cmd == "unmute":
            result = unmute()
        elif cmd == "toggle":
            result = toggle()
        else:
            result = status()
    except Exception as e:
        result = {"error": "failed", "detail": str(e)}
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
