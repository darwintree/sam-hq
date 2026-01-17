from __future__ import annotations

import io
import os
from pathlib import Path
from threading import Lock

import numpy as np
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import HTMLResponse, Response
from PIL import Image
from sam2.build_sam import build_sam2
from sam2.sam2_image_predictor import SAM2ImagePredictor

APP_ROOT = Path(__file__).resolve().parent
INDEX_PATH = APP_ROOT / "index.html"

MODEL_CFG = os.environ.get(
    "SAM2_MODEL_CFG",
    "configs/sam2.1/sam2.1_hq_hiera_l.yaml",
)
CHECKPOINT_PATH = os.environ.get(
    "SAM2_CHECKPOINT",
    "checkpoints/sam2.1_hq_hiera_large.pt",
)

app = FastAPI(title="HQ-SAM2 Background Remover")

_predictor: SAM2ImagePredictor | None = None
_predictor_lock = Lock()


def get_predictor() -> SAM2ImagePredictor:
    global _predictor
    if _predictor is None:
        checkpoint = Path(CHECKPOINT_PATH)
        if not checkpoint.exists():
            raise FileNotFoundError(
                "SAM2 checkpoint not found. Set SAM2_CHECKPOINT to a valid file."
            )
        model = build_sam2(MODEL_CFG, str(checkpoint))
        _predictor = SAM2ImagePredictor(model)
    return _predictor


@app.get("/", response_class=HTMLResponse)
def index() -> HTMLResponse:
    if not INDEX_PATH.exists():
        raise HTTPException(status_code=500, detail="index.html not found")
    return HTMLResponse(INDEX_PATH.read_text(encoding="utf-8"))


@app.post("/api/segment")
def segment_image(
    image: UploadFile = File(...),
    point_x: float = Form(...),
    point_y: float = Form(...),
) -> Response:
    if image.content_type not in {"image/png", "image/jpeg", "image/jpg", "image/webp"}:
        raise HTTPException(status_code=400, detail="Unsupported image type")

    raw = image.file.read()
    try:
        pil_image = Image.open(io.BytesIO(raw)).convert("RGB")
    except Exception as exc:  # noqa: BLE001 - surface parsing errors
        raise HTTPException(status_code=400, detail="Invalid image") from exc

    image_array = np.array(pil_image)
    height, width = image_array.shape[:2]
    if not (0 <= point_x <= width and 0 <= point_y <= height):
        raise HTTPException(status_code=400, detail="Point must be inside the image")

    predictor = get_predictor()
    with _predictor_lock:
        predictor.set_image(image_array)
        masks, scores, _ = predictor.predict(
            point_coords=np.array([[point_x, point_y]]),
            point_labels=np.array([1]),
            multimask_output=True,
        )

    best_index = int(np.argmax(scores))
    mask = masks[best_index]
    alpha = (mask.astype(np.uint8) * 255)
    rgba = pil_image.convert("RGBA")
    rgba.putalpha(Image.fromarray(alpha, mode="L"))

    output = io.BytesIO()
    rgba.save(output, format="PNG")
    output.seek(0)
    return Response(content=output.read(), media_type="image/png")
