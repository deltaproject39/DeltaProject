"""Delta's sketchbook brush: draws a picture from a text description, on this PC's CPU.

Model: LCM Dreamshaper v7 (OpenVINO int8, MIT licence) in server/models/art. It's a 4-step
model, so a 512x512 picture takes about 20 seconds without a graphics card.

The model is only loaded while she's drawing, and unloaded after a few quiet minutes so it
doesn't sit in RAM. Only the gatekeeper (on this PC) talks to it; it's never exposed to the
internet.

Run:   server/.venv-art/Scripts/python server/art_server.py
"""

import io
import json
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import openvino_genai as og
from PIL import Image

HERE = Path(__file__).parent
PORT = 8789
MODEL = HERE / "models" / "art"
SIZE = 512
STEPS = 4
GUIDANCE = 8.0
UNLOAD_AFTER_SECONDS = 10 * 60
MAX_PROMPT_CHARS = 600

pipe = None
last_used = 0.0
drawing = threading.Lock()   # one picture at a time
cancelled = threading.Event()


def pipeline():
    global pipe
    if pipe is None:
        started = time.time()
        pipe = og.Text2ImagePipeline(str(MODEL), "CPU")
        print(f"Brush ready ({time.time() - started:.0f}s).", flush=True)
    return pipe


def draw(prompt, seed):
    """A PNG of `prompt`, or None if she was interrupted."""
    global last_used
    with drawing:
        cancelled.clear()
        # Called after each step: returning True stops the picture early.
        stop = lambda step, steps, latent: cancelled.is_set()
        result = pipeline().generate(
            prompt, width=SIZE, height=SIZE, num_inference_steps=STEPS,
            guidance_scale=GUIDANCE, rng_seed=seed, callback=stop,
        )
        last_used = time.time()
        if cancelled.is_set():
            return None
        out = io.BytesIO()
        Image.fromarray(result.data[0]).save(out, format="PNG", optimize=True)
        return out.getvalue()


def unload_when_idle():
    global pipe
    while True:
        time.sleep(60)
        if pipe is not None and time.time() - last_used > UNLOAD_AFTER_SECONDS and drawing.acquire(blocking=False):
            try:
                pipe = None
                print("Brush put away (unloaded to free memory).", flush=True)
            finally:
                drawing.release()


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        pass

    def send(self, status, body, content_type="application/json"):
        if isinstance(body, (dict, list)):
            body = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/health":
            return self.send(200, {"ok": True, "loaded": pipe is not None, "busy": drawing.locked()})
        self.send(404, {"error": "Not found"})

    def do_POST(self):
        if self.path == "/cancel":
            cancelled.set()
            return self.send(200, {"ok": True})
        if self.path != "/draw":
            return self.send(404, {"error": "Not found"})
        try:
            length = int(self.headers.get("Content-Length", 0))
            msg = json.loads(self.rfile.read(min(length, 10_000)) or b"{}")
            prompt = str(msg.get("prompt", "")).strip()[:MAX_PROMPT_CHARS]
            seed = int(msg.get("seed", time.time())) % 2**31
        except (ValueError, TypeError):
            return self.send(400, {"error": "Bad request"})
        if not prompt:
            return self.send(400, {"error": "Nothing to draw"})
        try:
            png = draw(prompt, seed)
        except Exception as err:  # noqa: BLE001 - report any model failure to the caller
            print("Drawing failed:", err, flush=True)
            return self.send(500, {"error": str(err)})
        if png is None:
            return self.send(409, {"error": "Interrupted"})
        self.send(200, png, "image/png")


if __name__ == "__main__":
    threading.Thread(target=unload_when_idle, daemon=True).start()
    print(f"Delta's brush on http://127.0.0.1:{PORT} (model loads on first drawing)", flush=True)
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
