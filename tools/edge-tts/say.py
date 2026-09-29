#!/usr/bin/env python3
"""edge-tts 薄封装：**从文件读文本**，合成到指定 mp3。

为什么不把文本放命令行参数：Windows 控制台编码会把中文和引号弄坏（本机踩过），
所以待朗读的文本一律走 UTF-8 文件。

用法:
    .venv/Scripts/python.exe say.py --text-file t.txt --out a.mp3 --voice en-US-AriaNeural --rate +0%

退出码 0 成功（stdout 打印 `OK <字节数>`）；非 0 失败（stderr 有原因）。
"""
import argparse
import asyncio
import sys
from pathlib import Path

import edge_tts


async def synth(args) -> int:
    text = Path(args.text_file).read_text(encoding="utf-8").strip()
    if not text:
        print("ERR 文本为空", file=sys.stderr)
        return 2
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    if out.exists():
        out.unlink()  # 别把上一次的残留当成这次的结果

    communicate = edge_tts.Communicate(
        text,
        args.voice,
        rate=args.rate,
        volume=args.volume,
        pitch=args.pitch,
    )
    await communicate.save(str(out))

    size = out.stat().st_size if out.exists() else 0
    if size < 256:
        print(f"ERR 合成结果过小（{size} 字节）", file=sys.stderr)
        return 3
    print(f"OK {size}")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--text-file", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--voice", default="en-US-AriaNeural")
    ap.add_argument("--rate", default="+0%")
    ap.add_argument("--volume", default="+0%")
    ap.add_argument("--pitch", default="+0Hz")
    args = ap.parse_args()
    try:
        return asyncio.run(synth(args))
    except Exception as exc:  # 网络/音色名写错/上游改协议，都从这里出去
        print(f"ERR {type(exc).__name__}: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
