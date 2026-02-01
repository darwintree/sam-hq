# HQ-SAM2 Background Remover Web App

这个应用基于 `SAM2ImagePredictor`，提供上传图片 + 点击前景/背景点的方式，生成透明背景 PNG。

## 准备模型权重

下载 HQ-SAM2 的 checkpoint（示例同 `notebooks/image_predictor_example.ipynb`）：

```bash
bash sam-hq2/checkpoints/download_ckpts.sh
```

配置权重路径和配置文件

```bash
export SAM2_CHECKPOINT="/absolute/path/to/sam-hq2/checkpoints/sam2.1_hq_hiera_large.pt"
export SAM2_MODEL_CFG="configs/sam2.1/sam2.1_hq_hiera_l.yaml"
```

也可以配置 sam2.1 的权重

```bash
export SAM2_CHECKPOINT="/absolute/path/to/sam-hq2/checkpoints/sam2.1_hiera_small.pt"
export SAM2_MODEL_CFG="configs/sam2.1/sam2.1_hiera_s.yaml"
```

可选：指定运行设备（默认 `cuda`）：

```bash
export SAM2_DEVICE=cpu
```

## 运行

```bash
uvicorn main:app --reload --host 0.0.0.0 --port 8000
```

访问 `http://localhost:8000`，上传图片并点击主体与背景点即可生成透明 PNG。
