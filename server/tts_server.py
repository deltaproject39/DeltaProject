"""Delta's voice: Kokoro text-to-speech with adjustable voice, speed and pitch, plus an
emotion reader (go_emotions) that colours how each sentence is spoken and tells the page
which face to make.

Listens on localhost only. The gatekeeper forwards just POST /tts and POST /emotion (text
only) from the internet; everything else, including the Voice Lab and saving settings, is
reachable only from this PC.

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
import onnxruntime
import soundfile as sf
from kokoro_onnx import Kokoro
from tokenizers import Tokenizer

HERE = Path(__file__).parent
PORT = 8788
MODEL = HERE / "models" / "kokoro-v1.0.onnx"
VOICES = HERE / "models" / "voices-v1.0.bin"
SETTINGS = HERE / "voice.json"
LAB_PAGE = HERE / "voice-lab.html"
EMOTION_DIR = HERE / "models" / "emotion"
FFMPEG = "ffmpeg"  # see find_ffmpeg()
MAX_CHARS = 1000

DEFAULTS = {"voice": "af_heart", "speed": 1.0, "pitch": 0.0}


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


# The 28 go_emotions labels, grouped into the feelings Delta's face can show.
EMOTION_GROUPS = {
    "happy": ["joy", "amusement", "excitement", "love", "gratitude", "optimism", "pride",
              "admiration", "approval", "caring", "relief", "desire"],
    "sad": ["sadness", "grief", "disappointment", "remorse", "embarrassment"],
    "angry": ["anger", "annoyance", "disapproval", "disgust"],
    "surprised": ["surprise", "realization"],
    "curious": ["curiosity", "confusion"],
    "scared": ["fear", "nervousness"],
}
GROUP_OF = {label: group for group, labels in EMOTION_GROUPS.items() for label in labels}

# How each feeling nudges her delivery at full strength: (semitones, speed multiplier).
PROSODY = {
    "happy": (0.8, 1.04),
    "sad": (-1.2, 0.9),
    "angry": (-0.4, 1.06),
    "surprised": (1.5, 1.05),
    "curious": (0.6, 1.0),
    "scared": (0.8, 1.08),
    "neutral": (0.0, 1.0),
}
EXCITED = {"excitement", "amusement"}  # a bit more lift than plain happiness


class EmotionReader:
    def __init__(self, folder):
        self.tokenizer = Tokenizer.from_file(str(folder / "tokenizer.json"))
        self.tokenizer.enable_truncation(max_length=128)
        self.session = onnxruntime.InferenceSession(str(folder / "model_quantized.onnx"))
        config = json.loads((folder / "config.json").read_text(encoding="utf-8"))
        self.labels = [config["id2label"][str(i)] for i in range(len(config["id2label"]))]

    def read(self, text):
        """Strongest non-neutral feeling in the text, or neutral if nothing stands out."""
        enc = self.tokenizer.encode(text)
        logits = self.session.run(None, {
            "input_ids": np.array([enc.ids], dtype=np.int64),
            "attention_mask": np.array([enc.attention_mask], dtype=np.int64),
        })[0][0]
        scores = 1 / (1 + np.exp(-logits))
        # Strength of each feeling = its strongest underlying label, plus "neutral" for calm.
        groups = {group: 0.0 for group in EMOTION_GROUPS}
        for label, score in zip(self.labels, scores):
            if label in GROUP_OF:
                groups[GROUP_OF[label]] = max(groups[GROUP_OF[label]], float(score))
        groups["neutral"] = float(scores[self.labels.index("neutral")])
        groups = {k: round(v, 3) for k, v in groups.items()}

        best = max((i for i, label in enumerate(self.labels) if label != "neutral"), key=lambda i: scores[i])
        label, score = self.labels[best], float(scores[best])
        if score < 0.25:
            return {"emotion": "neutral", "label": "neutral", "score": 1.0, "groups": groups}
        return {"emotion": GROUP_OF.get(label, "neutral"), "label": label, "score": round(score, 3), "groups": groups}


def with_feeling(settings, feeling):
    """Saved voice settings, nudged toward the sentence's emotion."""
    pitch, speed = PROSODY[feeling["emotion"]]
    if feeling["label"] in EXCITED:
        pitch, speed = 1.5, 1.07
    strength = min(1.0, feeling["score"])
    return {**settings, "pitch": settings["pitch"] + pitch * strength,
            "speed": settings["speed"] * (1 + (speed - 1) * strength)}


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
    }


kokoro = Kokoro(str(MODEL), str(VOICES))
voice_names = sorted(kokoro.get_voices())
ffmpeg = find_ffmpeg()
emotions = EmotionReader(EMOTION_DIR)
lock = threading.Lock()  # one synthesis at a time keeps the CPU free for Ollama


def synthesize(text, settings):
    """Returns WAV bytes.

    Pitch works like changing a record's speed: Kokoro speaks more slowly than asked (its own,
    natural-sounding speed control), then the audio is resampled faster, which raises the pitch
    and brings the speed back. Nothing is time-stretched, so there are no robotic artifacts;
    the voice's tone moves with the pitch (higher sounds younger).
    """
    ratio = 2 ** (settings["pitch"] / 12) if ffmpeg else 1.0
    speak_speed = min(2.0, max(0.5, settings["speed"] / ratio))
    with lock:
        samples, rate = kokoro.create(text, voice=settings["voice"], speed=speak_speed, lang="en-us")
    buf = io.BytesIO()
    sf.write(buf, np.asarray(samples), rate, format="WAV", subtype="PCM_16")
    wav = buf.getvalue()
    if abs(ratio - 1) < 0.001:
        return wav
    result = subprocess.run(
        [ffmpeg, "-hide_banner", "-loglevel", "error", "-f", "wav", "-i", "pipe:0",
         "-af", f"asetrate={rate * ratio:.2f},aresample={rate}:resampler=soxr", "-f", "wav", "pipe:1"],
        input=wav, capture_output=True, check=True,
    )
    return result.stdout


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        pass  # keep the console quiet

    def send(self, status, body, content_type="application/json", headers=None):
        if isinstance(body, (dict, list)):
            body = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        for name, value in (headers or {}).items():
            self.send_header(name, value)
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

        if self.path in ("/tts", "/emotion"):
            text = str(body.get("text", "")).strip()[:MAX_CHARS]
            if not text:
                return self.send(400, {"error": "No text"})
            feeling = emotions.read(text)
            if self.path == "/emotion":
                return self.send(200, feeling)
            # The Voice Lab can preview unsaved settings; the website always uses the saved ones.
            settings = clean_settings({**load_settings(), **body.get("preview", {})}, voice_names) \
                if "preview" in body else load_settings()
            if body.get("feeling", True):
                settings = with_feeling(settings, feeling)
            # Her personality's pace (sent by the gatekeeper), on top of the saved speed.
            pace = min(1.2, max(0.8, float(body.get("pace", 1.0) or 1.0)))
            settings = {**settings, "speed": settings["speed"] * pace}
            try:
                tag = f'{feeling["emotion"]}:{feeling["score"]}:{feeling["label"]}'
                all_groups = ",".join(f"{k}={v}" for k, v in feeling["groups"].items())
                return self.send(200, synthesize(text, settings), "audio/wav",
                                 {"X-Emotion": tag, "X-Emotion-Groups": all_groups})
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
