# 朗读工具（edge-tts）—— 可选

「每日一句」的**整句朗读**默认走边车的 `/api/tts/speak`：它 `spawn` 一个 Python 脚本合成 mp3
并落盘缓存（同一句话只合成一次）。上游是 **edge-tts**（微软 Edge 的在线朗读服务）：
音色自然、免费、**不需要账号与密钥**，但需要联网，且要装 Python 包。

没配也能用：**没配 = 前端回落浏览器自带的朗读**（`speechSynthesis`）。
所以这是「可选增强」，不是必需件。

## 装法（Windows）

```bat
:: 1) 建一个目录放这套工具，比如 C:\工具\edge-tts
::    把本目录的 say.py 拷进去
:: 2) 在里面建 venv 并装 edge-tts
cd /d C:\工具\edge-tts
python -m venv .venv
.venv\Scripts\python.exe -m pip install -U edge-tts
:: 3) 自检（应打印 OK <字节数>，并在同目录生成 out.mp3）
echo Hello from edge tts>t.txt
.venv\Scripts\python.exe say.py --text-file t.txt --out out.mp3 --voice en-US-AriaNeural
```

然后在 `server/config.json` 里把目录填进去（也可以在页面上改 —— 见 `docs/CONFIG.md`）：

```json
{ "tts": { "dir": "C:/工具/edge-tts" } }
```

改完**重启边车**。自检：`GET /api/tts/status` 应回 `ready: true`；
`GET /api/tts/speak?text=hello` 应回一段 `audio/mpeg`。

## 为什么是「子进程 + 落盘缓存」

- edge-tts 是 Python 包，Node 22 的原生 WebSocket 不支持自定义 header，
  重写它那套带签名的协议不划算 —— 于是复用「工具目录 + venv + spawn」这条路；
- 但合成的文本（每日一句这种）一天只变一次，**缓存命中后是纯读盘**，
  进程启动那点开销被摊平了，不值得再养一个常驻服务。

## 两个坑（`say.py` 已经替你处理了）

1. **文本走文件，不走命令行参数** —— Windows 控制台编码会把中文和引号弄坏；
2. **合成结果过小（< 256 字节）要当失败** —— 上游偶发只回一个空壳，别把它缓存下来。
