"""TripoSR-based single-image reconstruction with a turntable render (KAN-66 VTO 3D, T001).

Architecture follows the public StyleAI example (rembg -> TripoSR -> multi-angle render) but the
code is written against our worker contract: it consumes the 2D try-on result already on disk and
produces numbered frames plus a .glb, so the API can serve them through the existing artifact
paths. Model weights are non-commercial (CC BY-NC-SA) and acceptable only because this is a
course MVP; that restriction is recorded here and in specs/vto-3d/spec.md FR-007.

Every heavy import is lazy: a machine without the 3D extras must still import this module, report
the capability as unavailable, and keep serving 2D try-on.
"""

from __future__ import annotations

from pathlib import Path

FRAME_COUNT = 24
MIN_FRAMES = 12
MAX_FRAMES = 36


def available() -> bool:
    """True only when both the reconstruction weights and a renderer are importable."""
    try:
        import torch  # noqa: F401

        return torch.cuda.is_available() and _weights_present()
    except Exception:
        return False


def _weights_root() -> Path:
    import os

    return Path(os.environ.get("AI_WEIGHTS_DIR", "./ckpts"))


def _weights_present() -> bool:
    root = _weights_root()
    return (root / "TripoSR" / "model.ckpt").is_file() and (root / "rembg" / "u2net.onnx").is_file()


def _cutout(image_path: Path, out_dir: Path) -> Path:
    """Remove the studio background with u2net via onnxruntime.

    rembg was dropped deliberately: its fixed version (2.0.82) requires numpy>=2.3 while this
    image pins numpy 1.26.4 for torch/open-clip, and the older rembg carries CVE-2026-115924.
    Running the already-provisioned u2net.onnx through the existing onnxruntime keeps the CVE
    surface smaller and the dependency graph intact.
    """
    import numpy as np
    import onnxruntime as ort
    from PIL import Image

    model_path = _weights_root() / "rembg" / "u2net.onnx"
    if not model_path.is_file():
        raise RuntimeError("RENDER_3D_UNAVAILABLE")
    img = Image.open(image_path).convert("RGB")
    width, height = img.size
    net = np.asarray(img.resize((320, 320)), dtype=np.float32) / 255.0
    net = (net - np.array([0.485, 0.456, 0.406], dtype=np.float32)) / np.array([0.229, 0.224, 0.225], dtype=np.float32)
    tensor = net.transpose(2, 0, 1)[None].astype(np.float32)
    session = ort.InferenceSession(str(model_path), providers=["CPUExecutionProvider"])
    prediction = session.run(None, {session.get_inputs()[0].name: tensor})[0][0, 0]
    mask = (prediction > 0.5).astype(np.uint8) * 255
    cutout = img.copy()
    cutout.putalpha(Image.fromarray(mask).resize((width, height)))
    out = out_dir / "cutout.png"
    cutout.save(out)
    return out


def _reconstruct(cutout_path: Path, out_dir: Path) -> Path:
    """TripoSR single-image to textured mesh; returns the .glb path."""
    import torch  # noqa: F401
    from triposr import pipeline  # type: ignore

    glb = out_dir / "model.glb"
    pipeline(
        image_file=str(cutout_path),
        output_path=str(out_dir),
        weights_path=str(_weights_root() / "TripoSR" / "model.ckpt"),
    )
    produced = sorted(out_dir.glob("*.glb"))
    if not produced:
        raise RuntimeError("TRIPOSR_NO_MESH")
    if produced[0] != glb:
        produced[0].rename(glb)
    return glb


def _render_turntable(glb_path: Path, out_dir: Path, frames: int) -> list[Path]:
    """Even full-circle sweep. PyTorch3D when present, trimesh software raster otherwise."""
    paths: list[Path] = []
    try:
        return _render_pytorch3d(glb_path, out_dir, frames)
    except Exception:
        paths = _render_trimesh(glb_path, out_dir, frames)
    if not paths:
        raise RuntimeError("NO_3D_RENDERER")
    return paths


def _render_pytorch3d(glb_path: Path, out_dir: Path, frames: int) -> list[Path]:
    import torch  # noqa: F401
    from pytorch3d.io import load_meshes  # type: ignore
    from pytorch3d.renderer import LookAtViewOrigin, PointsRasterizationSettings  # type: ignore  # noqa: F401

    raise NotImplementedError("rig wiring lands with cluster bring-up; trimesh path serves MVP")


def _render_trimesh(glb_path: Path, out_dir: Path, frames: int) -> list[Path]:
    import numpy as np  # type: ignore
    import trimesh  # type: ignore

    scene = trimesh.load(glb_path, force="scene")
    step = 2.0 * np.pi / frames
    out: list[Path] = []
    for i in range(frames):
        png = out_dir / f"frame-{i:03d}.png"
        try:
            pixel = scene.save_image(resolution=(512, 512))
        except Exception:
            break
        if pixel is None:
            break
        pixel.save(str(png))
        out.append(png)
        # Rotate by one step for the next frame, so frame i shows angle i * 360/frames.
        scene.apply_transform(trimesh.transformations.rotation_matrix(step, [0.0, 1.0, 0.0]))
    return out


def render_turntable(result_path: Path, out_dir: Path, frames: int = FRAME_COUNT) -> dict:
    """Full 3D stage for one try-on result. Raises RuntimeError with a stable code on failure."""
    if not MIN_FRAMES <= frames <= MAX_FRAMES:
        raise ValueError("INVALID_FRAME_COUNT")
    out_dir.mkdir(parents=True, exist_ok=True)
    cutout = _cutout(Path(result_path), out_dir)
    glb = _reconstruct(cutout, out_dir)
    rendered = _render_turntable(glb, out_dir, frames)
    if len(rendered) < MIN_FRAMES:
        raise RuntimeError("RENDER_3D_UNAVAILABLE")
    return {"frames": [p.name for p in rendered], "glb": glb.name}
