# HQ-SAM2 Background Remover Web App

这个应用基于 `SAM2ImagePredictor`，提供上传图片 + 点击前景/背景点的方式，生成透明背景 PNG。

## 准备模型权重

下载 HQ-SAM2 的 checkpoint（示例同 `notebooks/image_predictor_example.ipynb`）：

```bash
bash sam-hq2/checkpoints/download_ckpts.sh
```

将权重路径配置给环境变量（示例）：

```bash
export SAM2_CHECKPOINT="/absolute/path/to/sam-hq2/checkpoints/sam2.1_hq_hiera_large.pt"
```

可选：调整模型配置文件：

```bash
export SAM2_MODEL_CFG="configs/sam2.1/sam2.1_hq_hiera_l.yaml"
```

## 运行

```bash
uvicorn sam-hq2.web_app.main:app --reload --host 0.0.0.0 --port 8000
```

访问 `http://localhost:8000`，上传图片并点击主体与背景点即可生成透明 PNG。
