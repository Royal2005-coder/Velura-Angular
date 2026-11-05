"""TripoSR turntable for a try-on result: u2net cutout, TSR mesh, NeRF sweep, one sprite sheet.

Provenance is enforced, not asserted: `vendor_triposr.py` assembles the MIT `tsr` tree at a pinned
revision and `weights-manifest.json` (accepted by `bootstrap_weights.py`, MIT/Apache-2.0 only) pins
every weight by publisher checksum. TripoSR is MIT (huggingface.co stabilityai/TripoSR, license:mit)
and the U-2-Net cutout is Apache-2.0.

The frames leave as a single tiled PNG because the worker transport is already "one PNG body plus a
compact X-AI-Result header"; the API slices it back into numbered frames, so nothing here has to
invent a multi-file response, and no renderer needs an OpenGL context inside the image.

Every heavy import is lazy: a machine without the 3D extras must still import this module, report the
capability as unavailable, and keep serving 2D try-on.
"""

from __future__ import annotations

from pathlib import Path

FRAME_COUNT = 24
MIN_FRAMES = 12
MAX_FRAMES = 36
TILE = 512
TILE_COLUMNS = 6
FOREGROUND_RATIO = 0.85
# 4096 rays per pass instead of upstream's 8192: the 2D pipeline keeps ~4.6 GiB of the 8 GiB card resident.
CHUNK_SIZE = 4096

ARTIFACTS = ("TripoSR/model.ckpt", "TripoSR/config.yaml", "TripoSR/image_tokenizer/config.json", "rembg/u2net.onnx")


def available() -> bool:
    """True only with CUDA, the provisioned reconstruction weights and the vendored tree."""
    try:
        import torch  # noqa: F401

        return torch.cuda.is_available() and _weights_present() and _vendor_present()
    except Exception:
        return False


def _weights_root() -> Path:
    import os

    return Path(os.environ.get("AI_WEIGHTS_DIR", "./ckpts"))


def _weights_present() -> bool:
    root = _weights_root()
    return all((root / relative).is_file() for relative in ARTIFACTS)


def _vendor_present() -> bool:
    """The patched tree, not the raw repository: without it TSR cannot even import."""
    import os
    import sys

    return bool(os.environ.get("TRIPOSR_IMAGE_TOKENIZER_CONFIG")) and any(
        Path(directory, "tsr", "system.py").is_file() for directory in sys.path
    )


def _cutout(image):
    """Background matte from the provisioned u2net through onnxruntime.

    rembg is deliberately not installed: its fixed version needs numpy>=2.3 while this image pins
    numpy 1.26.4 for torch/open-clip, and the older release carries a HIGH advisory. The same u2net
    weights run on the onnxruntime session that is already part of the image.
    """
    import numpy as np
    import onnxruntime as ort
    from PIL import Image

    weight = _weights_root() / "rembg" / "u2net.onnx"
    if not weight.is_file():
        raise RuntimeError("RENDER_3D_UNAVAILABLE")
    rgb = image.convert("RGB")
    width, height = rgb.size
    net = np.asarray(rgb.resize((320, 320)), dtype=np.float32) / 255.0
    net = (net - np.array([0.485, 0.456, 0.406], dtype=np.float32)) / np.array([0.229, 0.224, 0.225], dtype=np.float32)
    session = ort.InferenceSession(str(weight), providers=["CPUExecutionProvider"])
    prediction = session.run(None, {session.get_inputs()[0].name: net.transpose(2, 0, 1)[None].astype(np.float32)})[0][0, 0]
    cutout = rgb.copy()
    cutout.putalpha(Image.fromarray(((prediction > 0.5) * 255).astype(np.uint8)).resize((width, height)))
    return cutout


def _condition(cutout):
    """Square canvas, subject at FOREGROUND_RATIO of it, composited over mid grey: what TSR saw in training."""
    import numpy as np
    from PIL import Image

    cutout = cutout.convert("RGBA")
    alpha = np.asarray(cutout, dtype="uint8")[:, :, 3]
    rows, columns = np.nonzero(alpha > 8)
    if not len(rows):
        raise RuntimeError("EMPTY_CUTOUT")
    box = (int(columns.min()), int(rows.min()), int(columns.max()) + 1, int(rows.max()) + 1)
    subject = cutout.crop(box)
    side = max(subject.size)
    canvas = round(side / FOREGROUND_RATIO)
    paste = int((canvas - subject.size[0]) / 2), int((canvas - subject.size[1]) / 2)
    stage = Image.new("RGBA", (canvas, canvas), (0, 0, 0, 0))
    stage.paste(subject, paste, subject)
    background = Image.new("RGBA", stage.size, (128, 128, 128, 255))
    return Image.alpha_composite(background, stage).convert("RGB")


_MODEL = None


def _model():
    """Load TSR once from the provisioned directory; the image has no hub access to re-resolve it."""
    global _MODEL
    if _MODEL is not None:
        return _MODEL
    from tsr.system import TSR

    root = _weights_root() / "TripoSR"
    model = TSR.from_pretrained(str(root), config_name="config.yaml", weight_name="model.ckpt")
    model.renderer.set_chunk_size(CHUNK_SIZE)
    model.eval()
    model.to("cuda")
    _MODEL = model
    return model


def _tiles(frames: int) -> tuple[int, int]:
    rows = -(-frames // TILE_COLUMNS)
    return TILE_COLUMNS, rows


def turntable(image, frames: int = FRAME_COUNT) -> dict:
    """Reconstruct one try-on image and return a tiled 360° sheet plus the layout needed to slice it."""
    if not MIN_FRAMES <= frames <= MAX_FRAMES:
        raise ValueError("INVALID_FRAME_COUNT")
    import torch
    from PIL import Image

    conditioned = _condition(_cutout(image))
    model = _model()
    with torch.no_grad():
        scene_codes = model([conditioned], device="cuda")
        views = model.render(scene_codes, n_views=frames, height=TILE, width=TILE, return_type="pil")[0]
    if len(views) < MIN_FRAMES:
        raise RuntimeError("RENDER_3D_UNAVAILABLE")
    columns, rows = _tiles(len(views))
    sheet = Image.new("RGB", (columns * TILE, rows * TILE), (245, 242, 238))
    from io import BytesIO

    for index, view in enumerate(views):
        tile = view.convert("RGBA")
        cell = Image.new("RGBA", (TILE, TILE), (245, 242, 238, 255))
        cell.alpha_composite(tile.resize((TILE, TILE)))
        sheet.paste(cell.convert("RGB"), ((index % columns) * TILE, (index // columns) * TILE))
    buffer = BytesIO()
    sheet.save(buffer, format="PNG", optimize=True)
    return {"sprite": buffer.getvalue(), "frames": len(views), "columns": columns, "rows": rows, "tile": TILE}
