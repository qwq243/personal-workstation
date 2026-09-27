# -*- coding: utf-8 -*-
"""边车保活：Popen(node) + 长驻轮询。用 run_in_background 挂着，
后台任务存活期间 node 不会被回收；机器重启场景由 Startup VBS 覆盖。"""
import os, shutil, subprocess, time, urllib.request

# 路径都不写死本机：项目根 = 本文件的上两级目录（scripts/ 的父目录）；
# node 从 PATH（或环境变量 WS_NODE）找。理由与 restart-sidecar.py 顶部那段一样。
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _find_node():
    env = os.environ.get("WS_NODE")
    if env and os.path.exists(env):
        return env
    found = shutil.which("node")
    if found:
        return found
    for cand in (
        os.path.join(os.environ.get("ProgramFiles", r"C:\Program Files"), "nodejs", "node.exe"),
        os.path.join(os.environ.get("LOCALAPPDATA", ""), "Programs", "nodejs", "node.exe"),
    ):
        if cand and os.path.exists(cand):
            return cand
    return "node"


NODE = _find_node()
PORT = int(os.environ.get("WS_PORT") or 5278)
LOG = os.path.join(ROOT, "logs", "sidecar-keepalive.log")

opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def healthy():
    try:
        r = opener.open(f"http://127.0.0.1:{PORT}/api/health", timeout=3)
        return r.status == 200
    except Exception:
        return False


# wt 每次都会开一个可见终端窗口，而「无窗口」才是期望行为：有它只当最后手段，没有就直接游离进程。
WT = shutil.which("wt") or ""


def start_node():
    env = dict(os.environ)
    for k in ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"):
        env.pop(k, None)
    env["NO_PROXY"] = "*"
    # wt.exe 会脱离父进程所在的作业对象；直接 Popen(node, DETACHED) 在部分会话里会被立刻回收
    if os.path.exists(WT):
        return subprocess.Popen(
            [WT, "-d", ROOT, NODE, os.path.join(ROOT, "server", "index.mjs")],
            cwd=ROOT, env=env,
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            creationflags=subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP,
        )
    return subprocess.Popen(
        [NODE, os.path.join(ROOT, "server", "index.mjs")],
        cwd=ROOT, env=env,
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        creationflags=subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP,
    )


with open(LOG, "a", encoding="utf-8") as f:
    f.write(f"[{time.strftime('%H:%M:%S')}] keepalive start\n")
while True:
    try:
        if not healthy():
            start_node()
            for _ in range(25):
                time.sleep(1)
                if healthy():
                    with open(LOG, "a", encoding="utf-8") as f:
                        f.write(f"[{time.strftime('%H:%M:%S')}] node healthy\n")
                    break
            else:
                with open(LOG, "a", encoding="utf-8") as f:
                    f.write(f"[{time.strftime('%H:%M:%S')}] node FAILED to become healthy\n")
        time.sleep(20)
    except KeyboardInterrupt:
        break
