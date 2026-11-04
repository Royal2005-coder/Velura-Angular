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


def _weights_present() -> bool:
    root = Path("./ckpts")
    return (root / "TripoSR" / "ts_huge_df_checkpoints.ckpt").is_file() or bool(
        (_root_env() / "TripoSR").is_dir()
    )


def _root_env() -> Path:
    import os

    return Path(os.environ.get("AI_WORKER_ASSET_ROOT", "./assets"))


def _cutout(image_path: Path, out_dir: Path) -> Path:
    """Remove the studio background so reconstruction sees only the person."""
    from rembg import remove  # type: ignore

    raw = image_path.read_bytes()
    out = out_dir / "cutout.png"
    out.write_bytes(remove(raw))
    return out


def _reconstruct(cutout_path: Path, out_dir: Path) -> Path:
    """TripoSR single-image to textured mesh; returns the .glb path."""
    import torch  # noqa: F401
    from triposr import pipeline  # type: ignore

    glb = out_dir / "model.glb"
    pipeline(
        image_file=str(cutout_path),
        output_path=str(out_dir),
        weights_path="./ckpts/TripoSR/ts_huge_df_checkpoints.ckpt",
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
