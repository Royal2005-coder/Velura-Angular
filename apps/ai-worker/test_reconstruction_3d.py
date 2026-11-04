"""Contract tests for the VTO 3D stage (KAN-66 T005). No GPU, no heavy imports required."""

import sys
import types
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

import reconstruction_3d


class Availability(unittest.TestCase):
    def test_import_without_heavy_deps_succeeds_and_reports_unavailable(self):
        # CI machines have neither torch.cuda nor the TripoSR weights: the module must import
        # cleanly and answer False, so 2D try-on keeps working and 3D fails with a clear code.
        self.assertFalse(reconstruction_3d.available())

    def test_frame_count_bounds(self):
        for frames in (0, 11, 37, -3):
            with self.assertRaises(ValueError):
                reconstruction_3d.render_turntable(Path("x.png"), Path("out"), frames=frames)


class TurntableStage(unittest.TestCase):
    def _stub(self, rendered):
        """Inject fake rembg/trimesh modules so the stage runs hermetically."""
        rembg = types.ModuleType("rembg")
        rembg.remove = lambda raw: b"png"
        trimesh = types.ModuleType("trimesh")
        scene = types.SimpleNamespace()

        def save_image(resolution):
            if len(rendered) == 0:
                return None
            name = rendered.pop(0)
            Path(name).write_bytes(b"x")
            return types.SimpleNamespace(save=lambda p: Path(p).write_bytes(b"x"))

        scene.save_image = save_image
        scene.apply_transform = lambda m: None
        trimesh.load = lambda path, force=None: scene
        trimesh.scene = types.SimpleNamespace(Camera=lambda **k: None)
        trimesh.transformations = types.SimpleNamespace(rotation_matrix=lambda a, v: None)
        torch = types.ModuleType("torch")
        torch.cuda = types.SimpleNamespace(is_available=lambda: True)
        triposr = types.ModuleType("triposr")

        def pipeline(image_file, output_path, weights_path):
            Path(output_path, "model.glb").write_bytes(b"g")

        triposr.pipeline = pipeline
        np = types.ModuleType("numpy")
        np.pi = 3.14159
        return {"rembg": rembg, "trimesh": trimesh, "torch": torch, "triposr": triposr, "numpy": np}

    def test_produces_frames_and_glb(self):
        with TemporaryDirectory() as td:
            out = Path(td, "render3d")
            out.mkdir()
            Path(td, "result.png").write_bytes(b"i")
            names = [str(out / f"frame-{i:03d}.png") for i in range(40)]
            saved = sys.modules.copy()
            sys.modules.update(self._stub(names))
            try:
                result = reconstruction_3d.render_turntable(Path(td, "result.png"), out, frames=24)
            finally:
                for key in ("rembg", "trimesh", "torch", "triposr", "numpy"):
                    if key in saved:
                        sys.modules[key] = saved[key]
                    else:
                        del sys.modules[key]
            self.assertEqual(len(result["frames"]), 24)
            self.assertEqual(result["glb"], "model.glb")
            self.assertTrue(all(f.startswith("frame-") for f in result["frames"]))

    def test_sparse_render_below_minimum_raises(self):
        with TemporaryDirectory() as td:
            out = Path(td, "render3d")
            out.mkdir()
            Path(td, "result.png").write_bytes(b"i")
            names = [str(out / f"frame-{i:03d}.png") for i in range(5)]
            saved = sys.modules.copy()
            sys.modules.update(self._stub(names))
            try:
                with self.assertRaises(RuntimeError):
                    reconstruction_3d.render_turntable(Path(td, "result.png"), out, frames=24)
            finally:
                for key in ("rembg", "trimesh", "torch", "triposr", "numpy"):
                    if key in saved:
                        sys.modules[key] = saved[key]
                    else:
                        del sys.modules[key]


if __name__ == "__main__":
    unittest.main()
