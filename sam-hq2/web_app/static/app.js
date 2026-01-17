"use strict";

// DOM references.
const fileInput = document.getElementById("fileInput");
const canvas = document.getElementById("imageCanvas");
const ctx = canvas.getContext("2d");
const processBtn = document.getElementById("processBtn");
const foregroundBtn = document.getElementById("foregroundBtn");
const backgroundBtn = document.getElementById("backgroundBtn");
const boxBtn = document.getElementById("boxBtn");
const undoBtn = document.getElementById("undoBtn");
const redoBtn = document.getElementById("redoBtn");
const deleteBtn = document.getElementById("deleteBtn");
const clearBtn = document.getElementById("clearBtn");
const clearBoxBtn = document.getElementById("clearBoxBtn");
const resetViewBtn = document.getElementById("resetViewBtn");
const zoomLabel = document.getElementById("zoomLabel");
const status = document.getElementById("status");
const resultImage = document.getElementById("resultImage");
const resultPlaceholder = document.getElementById("resultPlaceholder");
const downloadLink = document.getElementById("downloadLink");
const maskToggle = document.getElementById("maskToggle");
const maskOpacity = document.getElementById("maskOpacity");
const canvasWrap = document.querySelector(".canvas-wrap");

const maskBuffer = document.createElement("canvas");
const maskBufferCtx = maskBuffer.getContext("2d");

// App state.
let currentImage = null;
let points = [];
let history = [];
let future = [];
let selectedPointId = null;
let nextPointId = 1;
let currentTool = "foreground";
let baseScale = 1;
let viewScale = 1;
let viewOffsetX = 0;
let viewOffsetY = 0;
let isPanning = false;
let isDraggingPoint = false;
let dragPointId = null;
let dragStart = null;
let panStart = null;
let panOrigin = null;
let pendingAddPoint = null;
let currentLabel = 1;
let inFlight = false;
let requestSeq = 0;
let resultUrl = null;
let resultMaskImage = null;
let box = null;
let boxPreview = null;
let isDrawingBox = false;
const MIN_BOX_SIZE = 4;

document.body.dataset.tool = currentTool;

function clonePoints(source) {
  return source.map((point) => ({ ...point }));
}

function cloneBox(source) {
  return source ? { ...source } : null;
}

function cloneState() {
  return { points: clonePoints(points), box: cloneBox(box) };
}

function updateUndoRedo() {
  undoBtn.disabled = history.length === 0;
  redoBtn.disabled = future.length === 0;
  deleteBtn.disabled = selectedPointId === null;
}

function updateToolControls() {
  const hasImage = Boolean(currentImage);
  foregroundBtn.disabled = !hasImage;
  backgroundBtn.disabled = !hasImage;
  boxBtn.disabled = !hasImage;
  clearBtn.disabled = !hasImage || points.length === 0;
  resetViewBtn.disabled = !hasImage;
}

function updateProcessState() {
  processBtn.disabled =
    !currentImage || (points.length === 0 && !box) || inFlight;
}

function updateBoxControls() {
  clearBoxBtn.disabled = !box;
}

function pushHistory() {
  history.push(cloneState());
  if (history.length > 50) {
    history.shift();
  }
  future = [];
  updateUndoRedo();
  updateBoxControls();
}

function updateZoomLabel() {
  zoomLabel.textContent = `${Math.round(viewScale * 100)}%`;
}

function setResultVisibility(hasResult) {
  resultImage.hidden = !hasResult;
  resultPlaceholder.hidden = hasResult;
  downloadLink.classList.toggle("disabled", !hasResult);
  downloadLink.setAttribute("aria-disabled", String(!hasResult));
}

function clearResult() {
  if (resultUrl) {
    URL.revokeObjectURL(resultUrl);
    resultUrl = null;
  }
  resultImage.removeAttribute("src");
  downloadLink.removeAttribute("href");
  resultMaskImage = null;
  maskToggle.checked = true;
  maskToggle.disabled = true;
  maskOpacity.disabled = true;
  setResultVisibility(false);
}

function getFitSize() {
  const maxWidth = 600;
  const ratio = currentImage.naturalWidth / currentImage.naturalHeight;
  const width = Math.min(maxWidth, currentImage.naturalWidth);
  const height = Math.round(width / ratio);
  return { width, height };
}

function resetView() {
  viewScale = 1;
  viewOffsetX = 0;
  viewOffsetY = 0;
  updateZoomLabel();
}

function toImageCoords(displayX, displayY) {
  const scale = baseScale * viewScale;
  // Convert screen space to original image space.
  return {
    x: (displayX - viewOffsetX) / scale,
    y: (displayY - viewOffsetY) / scale,
  };
}

function toDisplayCoords(imageX, imageY) {
  const scale = baseScale * viewScale;
  // Convert original image space to screen space.
  return {
    x: imageX * scale + viewOffsetX,
    y: imageY * scale + viewOffsetY,
  };
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function buildBoxFromPoints(start, end) {
  const maxX = currentImage ? currentImage.naturalWidth : 0;
  const maxY = currentImage ? currentImage.naturalHeight : 0;
  const x1 = clamp(Math.min(start.x, end.x), 0, maxX);
  const y1 = clamp(Math.min(start.y, end.y), 0, maxY);
  const x2 = clamp(Math.max(start.x, end.x), 0, maxX);
  const y2 = clamp(Math.max(start.y, end.y), 0, maxY);
  return { x1, y1, x2, y2 };
}

function getCanvasCoords(event) {
  const rect = canvas.getBoundingClientRect();
  const scaleX = canvas.width / rect.width;
  const scaleY = canvas.height / rect.height;
  // Translate CSS pixel coords into canvas pixel coords.
  return {
    x: (event.clientX - rect.left) * scaleX,
    y: (event.clientY - rect.top) * scaleY,
  };
}

function hitTestPoint(displayX, displayY) {
  let closest = null;
  let closestDist = Infinity;
  points.forEach((point) => {
    const display = toDisplayCoords(point.x, point.y);
    const dx = display.x - displayX;
    const dy = display.y - displayY;
    const dist = Math.hypot(dx, dy);
    if (dist < 10 && dist < closestDist) {
      closest = point.id;
      closestDist = dist;
    }
  });
  return closest;
}

async function runSegmentation(source) {
  if (inFlight) return;
  const file = fileInput.files[0];
  if (!file || (points.length === 0 && !box)) return;
  inFlight = true;
  const requestId = ++requestSeq;
  updateProcessState();
  status.textContent = source === "auto" ? "正在更新预览..." : "正在处理...";
  const formData = new FormData();
  formData.append("image", file);
  formData.append(
    "points",
    JSON.stringify(points.map((point) => [point.x, point.y]))
  );
  formData.append(
    "labels",
    JSON.stringify(points.map((point) => point.label))
  );
  if (box) {
    formData.append("box", JSON.stringify([box.x1, box.y1, box.x2, box.y2]));
  }

  try {
    const response = await fetch("/api/segment", {
      method: "POST",
      body: formData,
    });
    if (!response.ok) {
      const detail = await response.text();
      throw new Error(detail || "服务器出错");
    }
    const blob = await response.blob();
    if (requestId !== requestSeq) return;
    if (resultUrl) {
      URL.revokeObjectURL(resultUrl);
    }
    resultUrl = URL.createObjectURL(blob);
    resultImage.src = resultUrl;
    downloadLink.href = resultUrl;
    setResultVisibility(true);
    resultMaskImage = new Image();
    resultMaskImage.onload = () => {
      updateMaskPreview();
    };
    resultMaskImage.src = resultUrl;
    maskToggle.disabled = false;
    maskOpacity.disabled = false;
    updateMaskPreview();
    status.textContent = source === "auto" ? "预览已更新" : "完成";
  } catch (error) {
    status.textContent = `处理失败：${error.message}`;
  } finally {
    inFlight = false;
    updateProcessState();
  }
}

function drawImage() {
  if (!currentImage) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    return;
  }
  const { width, height } = getFitSize();
  canvas.width = width;
  canvas.height = height;
  baseScale = width / currentImage.naturalWidth;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, width, height);
  ctx.setTransform(
    baseScale * viewScale,
    0,
    0,
    baseScale * viewScale,
    viewOffsetX,
    viewOffsetY
  );
  ctx.drawImage(currentImage, 0, 0);
  if (maskToggle.checked && resultMaskImage) {
    // Overlay a solid-color mask on the original image.
    renderMaskOverlay();
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  if (box || boxPreview) {
    if (box) {
      drawBoxOutline(box, false);
    }
    if (boxPreview) {
      drawBoxOutline(boxPreview, true);
    }
  }
  points.forEach((point) => {
    const display = toDisplayCoords(point.x, point.y);
    ctx.beginPath();
    ctx.arc(display.x, display.y, 6, 0, Math.PI * 2);
    ctx.fillStyle = point.label === 1 ? "#22c55e" : "#ef4444";
    ctx.fill();
    ctx.strokeStyle = "white";
    ctx.lineWidth = 2;
    ctx.stroke();
    if (point.id === selectedPointId) {
      ctx.beginPath();
      ctx.arc(display.x, display.y, 10, 0, Math.PI * 2);
      ctx.strokeStyle = "#1e3a8a";
      ctx.lineWidth = 2;
      ctx.stroke();
    }
  });
}

function drawBoxOutline(targetBox, dashed) {
  const topLeft = toDisplayCoords(targetBox.x1, targetBox.y1);
  const bottomRight = toDisplayCoords(targetBox.x2, targetBox.y2);
  const width = bottomRight.x - topLeft.x;
  const height = bottomRight.y - topLeft.y;
  ctx.save();
  ctx.strokeStyle = "#0ea5e9";
  ctx.lineWidth = 2;
  ctx.setLineDash(dashed ? [6, 4] : []);
  ctx.strokeRect(topLeft.x, topLeft.y, width, height);
  ctx.restore();
}

function updateMaskPreview() {
  drawImage();
}

function renderMaskOverlay() {
  if (!currentImage || !resultMaskImage) return;
  // Render a solid-color mask using the result alpha.
  const naturalWidth = resultMaskImage.naturalWidth || currentImage.naturalWidth;
  const naturalHeight =
    resultMaskImage.naturalHeight || currentImage.naturalHeight;
  maskBuffer.width = naturalWidth;
  maskBuffer.height = naturalHeight;

  maskBufferCtx.setTransform(1, 0, 0, 1, 0, 0);
  maskBufferCtx.clearRect(0, 0, naturalWidth, naturalHeight);
  maskBufferCtx.drawImage(resultMaskImage, 0, 0, naturalWidth, naturalHeight);
  maskBufferCtx.globalCompositeOperation = "source-in";
  maskBufferCtx.fillStyle = "#22c55e";
  maskBufferCtx.fillRect(0, 0, naturalWidth, naturalHeight);
  maskBufferCtx.globalCompositeOperation = "source-over";

  ctx.save();
  ctx.setTransform(
    baseScale * viewScale,
    0,
    0,
    baseScale * viewScale,
    viewOffsetX,
    viewOffsetY
  );
  ctx.globalAlpha = Number(maskOpacity.value);
  ctx.drawImage(maskBuffer, 0, 0);
  ctx.restore();
}

function refreshAfterChange() {
  drawImage();
  updateUndoRedo();
  updateProcessState();
  updateBoxControls();
  updateToolControls();
}

function finalizeBox() {
  if (!boxPreview) return;
  const width = Math.abs(boxPreview.x2 - boxPreview.x1);
  const height = Math.abs(boxPreview.y2 - boxPreview.y1);
  if (width < MIN_BOX_SIZE || height < MIN_BOX_SIZE) {
    boxPreview = null;
    isDrawingBox = false;
    drawImage();
    status.textContent = "框选太小，请重新拖动";
    return;
  }
  pushHistory();
  box = boxPreview;
  boxPreview = null;
  isDrawingBox = false;
  refreshAfterChange();
  status.textContent = "已添加框，点击生成";
  runSegmentation("auto");
}

fileInput.addEventListener("change", (event) => {
  const file = event.target.files[0];
  if (!file) return;
  const img = new Image();
  img.onload = () => {
    currentImage = img;
    points = [];
    history = [];
    future = [];
    selectedPointId = null;
    nextPointId = 1;
    box = null;
    boxPreview = null;
    isDrawingBox = false;
    resetView();
    updateUndoRedo();
    updateProcessState();
    updateBoxControls();
    updateToolControls();
    drawImage();
    status.textContent = "请在主体上点击或拖出框（可添加多个前景/背景点）";
    clearResult();
  };
  img.src = URL.createObjectURL(file);
});

function setTool(tool) {
  currentTool = tool;
  document.body.dataset.tool = tool;
  foregroundBtn.classList.toggle("active", tool === "foreground");
  backgroundBtn.classList.toggle("active", tool === "background");
  boxBtn.classList.toggle("active", tool === "box");
  if (tool === "foreground") {
    currentLabel = 1;
    if (currentImage) {
      status.textContent = "前景点模式：点击主体";
    }
  } else if (tool === "background") {
    currentLabel = 0;
    if (currentImage) {
      status.textContent = "背景点模式：点击要排除的区域";
    }
  } else if (currentImage) {
    status.textContent = "框选模式：拖动绘制矩形框";
  }
  selectedPointId = null;
  updateUndoRedo();
  updateToolControls();
  drawImage();
}

foregroundBtn.addEventListener("click", () => {
  setTool("foreground");
});

backgroundBtn.addEventListener("click", () => {
  setTool("background");
});

boxBtn.addEventListener("click", () => {
  setTool("box");
});

clearBtn.addEventListener("click", () => {
  if (points.length === 0) return;
  pushHistory();
  points = [];
  selectedPointId = null;
  drawImage();
  updateProcessState();
  updateUndoRedo();
  updateToolControls();
  status.textContent = "已清除点，请重新选择";
});

clearBoxBtn.addEventListener("click", () => {
  if (!box) return;
  pushHistory();
  box = null;
  boxPreview = null;
  drawImage();
  updateProcessState();
  updateBoxControls();
  updateToolControls();
  status.textContent = "已清除框，请重新选择";
});

undoBtn.addEventListener("click", () => {
  if (history.length === 0) return;
  future.push(cloneState());
  const previous = history.pop();
  points = previous.points;
  box = previous.box;
  selectedPointId = null;
  refreshAfterChange();
  runSegmentation("auto");
});

redoBtn.addEventListener("click", () => {
  if (future.length === 0) return;
  history.push(cloneState());
  const next = future.pop();
  points = next.points;
  box = next.box;
  selectedPointId = null;
  refreshAfterChange();
  runSegmentation("auto");
});

deleteBtn.addEventListener("click", () => {
  if (selectedPointId === null) return;
  pushHistory();
  points = points.filter((point) => point.id !== selectedPointId);
  selectedPointId = null;
  refreshAfterChange();
  runSegmentation("auto");
});

resetViewBtn.addEventListener("click", () => {
  resetView();
  drawImage();
});

maskToggle.addEventListener("change", () => {
  updateMaskPreview();
});

maskOpacity.addEventListener("input", () => {
  updateMaskPreview();
});

canvas.addEventListener("contextmenu", (event) => {
  event.preventDefault();
});

canvas.addEventListener("wheel", (event) => {
  if (!currentImage) return;
  event.preventDefault();
  const { x, y } = getCanvasCoords(event);
  const zoomFactor = event.deltaY < 0 ? 1.1 : 0.9;
  const nextScale = clamp(viewScale * zoomFactor, 0.5, 5);
  const scaleChange = nextScale / viewScale;
  viewOffsetX = x - (x - viewOffsetX) * scaleChange;
  viewOffsetY = y - (y - viewOffsetY) * scaleChange;
  viewScale = nextScale;
  updateZoomLabel();
  drawImage();
});

canvas.addEventListener("pointerdown", (event) => {
  if (!currentImage) return;
  const { x, y } = getCanvasCoords(event);
  const hitId = hitTestPoint(x, y);
  if (event.button === 1 || event.button === 2 || event.shiftKey) {
    isPanning = true;
    panStart = { x, y };
    panOrigin = { x: viewOffsetX, y: viewOffsetY };
    if (canvasWrap) {
      canvasWrap.classList.add("is-panning");
    }
    return;
  }
  if (currentTool === "box") {
    const imageCoords = toImageCoords(x, y);
    isDrawingBox = true;
    boxPreview = buildBoxFromPoints(imageCoords, imageCoords);
    selectedPointId = null;
    updateUndoRedo();
    drawImage();
    return;
  }
  if (hitId !== null) {
    selectedPointId = hitId;
    updateUndoRedo();
    drawImage();
    isDraggingPoint = true;
    dragPointId = hitId;
    dragStart = { x, y, moved: false };
    return;
  }
  selectedPointId = null;
  updateUndoRedo();
  drawImage();
  pendingAddPoint = { x, y, moved: false };
});

canvas.addEventListener("pointermove", (event) => {
  if (!currentImage) return;
  const { x, y } = getCanvasCoords(event);
  if (isPanning && panStart && panOrigin) {
    viewOffsetX = panOrigin.x + (x - panStart.x);
    viewOffsetY = panOrigin.y + (y - panStart.y);
    drawImage();
    return;
  }
  if (isDrawingBox && boxPreview) {
    const imageCoords = toImageCoords(x, y);
    boxPreview = buildBoxFromPoints(
      { x: boxPreview.x1, y: boxPreview.y1 },
      imageCoords
    );
    drawImage();
    return;
  }
  if (isDraggingPoint && dragPointId !== null) {
    const delta = Math.hypot(x - dragStart.x, y - dragStart.y);
    if (!dragStart.moved && delta < 2) {
      return;
    }
    if (!dragStart.moved) {
      pushHistory();
      dragStart.moved = true;
    }
    const imageCoords = toImageCoords(x, y);
    points = points.map((point) =>
      point.id === dragPointId
        ? { ...point, x: imageCoords.x, y: imageCoords.y }
        : point
    );
    drawImage();
    return;
  }
  if (pendingAddPoint) {
    const delta = Math.hypot(x - pendingAddPoint.x, y - pendingAddPoint.y);
    if (delta > 4) {
      pendingAddPoint.moved = true;
    }
  }
});

canvas.addEventListener("pointerup", (event) => {
  if (!currentImage) return;
  if (isPanning) {
    isPanning = false;
    panStart = null;
    panOrigin = null;
    if (canvasWrap) {
      canvasWrap.classList.remove("is-panning");
    }
    return;
  }
  if (isDrawingBox) {
    finalizeBox();
    return;
  }
  if (isDraggingPoint) {
    isDraggingPoint = false;
    dragPointId = null;
    if (dragStart && dragStart.moved) {
      refreshAfterChange();
      runSegmentation("auto");
    }
    dragStart = null;
    return;
  }
  if (pendingAddPoint && !pendingAddPoint.moved) {
    const imageCoords = toImageCoords(pendingAddPoint.x, pendingAddPoint.y);
    pushHistory();
    points.push({
      id: nextPointId++,
      x: imageCoords.x,
      y: imageCoords.y,
      label: currentLabel,
    });
    refreshAfterChange();
    status.textContent = "已添加点，点击生成";
    runSegmentation("auto");
  }
  pendingAddPoint = null;
});

processBtn.addEventListener("click", async () => {
  runSegmentation("manual");
});

setResultVisibility(false);
updateToolControls();
