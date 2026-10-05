"""Delta's voice: Kokoro text-to-speech with adjustable voice, speed and pitch.

Listens on localhost only. The gatekeeper forwards just POST /tts (text only) from the
internet; everything else, including the Voice Lab and saving settings, is reachable only
from this PC.

Run:   python server/tts_server.py
Lab:   http://localhost:8788/lab
"""

import io
import json
import subprocess
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import numpy as np
import soundfile as sf
from kokoro_onnx import Kokoro

HERE = Path(__file__).parent
PORT = 8788
MODEL = HERE / "models" / "kokoro-v1.0.onnx"
VOICES = HERE / "models" / "voices-v1.0.bin"
SETTINGS = HERE / "voice.json"
LAB_PAGE = HERE / "voice-lab.html"
FFMPEG = "ffmpeg"  # see find_ffmpeg()
MAX_CHARS = 1000

DEFAULTS = {"voice": "af_heart", "speed": 1.0, "pitch": 0.0, "natural": True}


def find_ffmpeg():
    """Use ffmpeg from PATH, or the copy winget installed (it isn't always on PATH)."""
    import shutil
    import os

    found = shutil.which("ffmpeg")
    if found:
        return found
    packages = Path(os.environ.get("LOCALAPPDATA", "")) / "Microsoft" / "WinGet" / "Packages"
    for exe in packages.glob("Gyan.FFmpeg*/**/ffmpeg.exe"):
        return str(exe)
    return None


def load_settings():
    try:
        return {**DEFAULTS, **json.loads(SETTINGS.read_text(encoding="utf-8"))}
    except (FileNotFoundError, json.JSONDecodeError):
        return dict(DEFAULTS)


def clean_settings(raw, voices):
    s = {**DEFAULTS, **(raw or {})}
    return {
        "voice": s["voice"] if s["voice"] in voices else DEFAULTS["voice"],
        "speed": float(min(2.0, max(0.5, float(s["speed"])))),
        "pitch": float(min(12.0, max(-12.0, float(s["pitch"])))),
        "natural": bool(s["natural"]),
    }


kokoro = Kokoro(str(MODEL), str(VOICES))
voice_names = sorted(kokoro.get_voices())
ffmpeg = find_ffmpeg()
lock = threading.Lock()  # one synthesis at a time keeps the CPU free for Ollama


def synthesize(text, settings):
    """Returns WAV bytes."""
    with lock:
        samples, rate = kokoro.create(text, voice=settings["voice"], speed=settings["speed"], lang="en-us")
    buf = io.BytesIO()
    sf.write(buf, np.asarray(samples), rate, format="WAV", subtype="PCM_16")
    wav = buf.getvalue()
    if abs(settings["pitch"]) < 0.01 or not ffmpeg:
        return wav
    # Rubber Band shifts pitch without changing speed. "Natural" keeps the voice's tone
    # (formants) so higher/lower sounds like the same person rather than a chipmunk.
    ratio = 2 ** (settings["pitch"] / 12)
    formant = "preserved" if settings["natural"] else "shifted"
    result = subprocess.run(
        [ffmpeg, "-hide_banner", "-loglevel", "error", "-f", "wav", "-i", "pipe:0",
         "-af", f"rubberband=pitch={ratio:.5f}:formant={formant}", "-f", "wav", "pipe:1"],
        input=wav, capture_output=True, check=True,
    )
    return result.stdout


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        pass  # keep the console quiet

    def send(self, status, body, content_type="application/json"):
        if isinstance(body, (dict, list)):
            body = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def read_json(self):
        length = int(self.headers.get("Content-Length") or 0)
        if length > 20_000:
            raise ValueError("too large")
        return json.loads(self.rfile.read(length) or b"{}")

    def do_GET(self):
        if self.path == "/lab":
            return self.send(200, LAB_PAGE.read_bytes(), "text/html; charset=utf-8")
        if self.path == "/settings":
            return self.send(200, load_settings())
        if self.path == "/voices":
            return self.send(200, voice_names)
        if self.path == "/health":
            return self.send(200, {"ok": True, "pitch": bool(ffmpeg)})
        self.send(404, {"error": "Not found"})

    def do_POST(self):
        try:
            body = self.read_json()
        except ValueError:
            return self.send(400, {"error": "Bad request"})

        if self.path == "/tts":
            text = str(body.get("text", "")).strip()[:MAX_CHARS]
            if not text:
                return self.send(400, {"error": "No text"})
            # The Voice Lab can preview unsaved settings; the website always uses the saved ones.
            settings = clean_settings({**load_settings(), **body.get("preview", {})}, voice_names) \
                if "preview" in body else load_settings()
            try:
                return self.send(200, synthesize(text, settings), "audio/wav")
            except Exception as err:  # noqa: BLE001
                print("TTS failed:", err)
                return self.send(500, {"error": "Voice failed"})

        if self.path == "/settings":
            settings = clean_settings(body, voice_names)
            SETTINGS.write_text(json.dumps(settings, indent=2) + "\n", encoding="utf-8")
            return self.send(200, settings)

        self.send(404, {"error": "Not found"})


if __name__ == "__main__":
    print(f"Delta's voice running on http://127.0.0.1:{PORT}  (Voice Lab: http://localhost:{PORT}/lab)")
    if not ffmpeg:
        print("Warning: ffmpeg not found, pitch changes are disabled.")
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
