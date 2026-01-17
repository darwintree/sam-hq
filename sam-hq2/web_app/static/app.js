"use strict";

// DOM references.
const fileInput = document.getElementById("fileInput");
const canvas = document.getElementById("imageCanvas");
const ctx = canvas.getContext("2d");
const processBtn = document.getElementById("processBtn");
const foregroundBtn = document.getElementById("foregroundBtn");
const backgroundBtn = document.getElementById("backgroundBtn");
const undoBtn = document.getElementById("undoBtn");
const redoBtn = document.getElementById("redoBtn");
const deleteBtn = document.getElementById("deleteBtn");
const clearBtn = document.getElementById("clearBtn");
const resetViewBtn = document.getElementById("resetViewBtn");
const zoomLabel = document.getElementById("zoomLabel");
const status = document.getElementById("status");
const resultImage = document.getElementById("resultImage");
const downloadLink = document.getElementById("downloadLink");
const maskToggle = document.getElementById("maskToggle");
const maskOpacity = document.getElementById("maskOpacity");

const maskBuffer = document.createElement("canvas");
const maskBufferCtx = maskBuffer.getContext("2d");

// App state.
let currentImage = null;
let points = [];
let history = [];
let future = [];
let selectedPointId = null;
let nextPointId = 1;
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

function clonePoints(source) {
  return source.map((point) => ({ ...point }));
}

function updateUndoRedo() {
  undoBtn.disabled = history.length === 0;
  redoBtn.disabled = future.length === 0;
  deleteBtn.disabled = selectedPointId === null;
}

function updateProcessState() {
  processBtn.disabled = points.length === 0 || inFlight;
}

function pushHistory() {
  history.push(clonePoints(points));
  if (history.length > 50) {
    history.shift();
  }
  future = [];
  updateUndoRedo();
}

function updateZoomLabel() {
  zoomLabel.textContent = `${Math.round(viewScale * 100)}%`;
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
  if (!file || points.length === 0) return;
  inFlight = true;
  const requestId = ++requestSeq;
  updateProcessState();
  status.textContent = source === "auto" ? "正在预览..." : "正在处理...";
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
    resultMaskImage = new Image();
    resultMaskImage.onload = () => {
      updateMaskPreview();
    };
    resultMaskImage.src = resultUrl;
    maskToggle.disabled = false;
    maskOpacity.disabled = false;
    updateMaskPreview();
    status.textContent = "完成";
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
    resetView();
    updateUndoRedo();
    updateProcessState();
    drawImage();
    status.textContent = "请在主体上点击（可添加多个前景/背景点）";
    resetViewBtn.disabled = false;
    // Default to showing the mask overlay once it becomes available.
    maskToggle.checked = true;
    maskToggle.disabled = true;
    maskOpacity.disabled = true;
  };
  img.src = URL.createObjectURL(file);
});

foregroundBtn.addEventListener("click", () => {
  currentLabel = 1;
  status.textContent = "前景点模式：点击主体";
});

backgroundBtn.addEventListener("click", () => {
  currentLabel = 0;
  status.textContent = "背景点模式：点击要排除的区域";
});

clearBtn.addEventListener("click", () => {
  if (points.length === 0) return;
  pushHistory();
  points = [];
  selectedPointId = null;
  drawImage();
  updateProcessState();
  updateUndoRedo();
  status.textContent = "已清除点，请重新选择";
});

undoBtn.addEventListener("click", () => {
  if (history.length === 0) return;
  future.push(clonePoints(points));
  points = history.pop();
  selectedPointId = null;
  refreshAfterChange();
  runSegmentation("auto");
});

redoBtn.addEventListener("click", () => {
  if (future.length === 0) return;
  history.push(clonePoints(points));
  points = future.pop();
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
