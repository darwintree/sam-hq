from __future__ import annotations

import io
import json
import os
from pathlib import Path
from threading import Lock

import numpy as np
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles
from PIL import Image
from sam2.build_sam import build_sam2
from sam2.sam2_image_predictor import SAM2ImagePredictor

APP_ROOT = Path(__file__).resolve().parent
STATIC_DIR = APP_ROOT / "static"
INDEX_PATH = STATIC_DIR / "index.html"

MODEL_CFG = os.environ.get(
    "SAM2_MODEL_CFG",
    "configs/sam2.1/sam2.1_hq_hiera_l.yaml",
)
CHECKPOINT_PATH = os.environ.get(
    "SAM2_CHECKPOINT",
    "checkpoints/sam2.1_hq_hiera_large.pt",
)

app = FastAPI(title="HQ-SAM2 Background Remover")
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")

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


@app.get("/")
def index() -> FileResponse:
    if not INDEX_PATH.exists():
        raise HTTPException(status_code=500, detail="index.html not found")
    return FileResponse(INDEX_PATH)


@app.post("/api/segment")
def segment_image(
    image: UploadFile = File(...),
    points: str = Form("[]"),
    labels: str = Form("[]"),
    box: str | None = Form(None),
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
    try:
        point_list = json.loads(points)
        label_list = json.loads(labels)
    except json.JSONDecodeError as exc:
        raise HTTPException(status_code=400, detail="Invalid points payload") from exc

    if len(point_list) != len(label_list):
        raise HTTPException(status_code=400, detail="Points and labels must align")
    for point in point_list:
        if len(point) != 2:
            raise HTTPException(status_code=400, detail="Each point must be [x, y]")
        if not (0 <= point[0] <= width and 0 <= point[1] <= height):
            raise HTTPException(status_code=400, detail="Point must be inside the image")

    box_coords = None
    if box:
        try:
            box_payload = json.loads(box)
        except json.JSONDecodeError as exc:
            raise HTTPException(status_code=400, detail="Invalid box payload") from exc
        if len(box_payload) != 4:
            raise HTTPException(status_code=400, detail="Box must be [x1, y1, x2, y2]")
        x1, y1, x2, y2 = box_payload
        if x2 <= x1 or y2 <= y1:
            raise HTTPException(
                status_code=400,
                detail="Box coordinates must define a valid rectangle",
            )
        if not (0 <= x1 <= width and 0 <= x2 <= width and 0 <= y1 <= height and 0 <= y2 <= height):
            raise HTTPException(status_code=400, detail="Box must be inside the image")
        box_coords = np.array([x1, y1, x2, y2], dtype=np.float32)

    if not point_list and box_coords is None:
        raise HTTPException(status_code=400, detail="Provide points or a box")

    predictor = get_predictor()
    with _predictor_lock:
        predictor.set_image(image_array)
        point_coords = (
            np.array(point_list, dtype=np.float32) if point_list else None
        )
        point_labels = (
            np.array(label_list, dtype=np.int64) if point_list else None
        )
        masks, scores, _ = predictor.predict(
            point_coords=point_coords,
            point_labels=point_labels,
            box=box_coords[None, :] if box_coords is not None else None,
            multimask_output=not (box_coords is not None and not point_list),
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
