"""Contract tests for the VTO 3D stage (KAN-66 T005). No GPU, no vendored tree, no heavy imports."""

import os
import sys
import types
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import mock

import reconstruction_3d
from PIL import Image


def torch_stub(cuda_available: bool = True) -> types.ModuleType:
    """Only `cuda.is_available` and `no_grad` are ever touched by the paths under test."""
    torch = types.ModuleType("torch")
    torch.cuda = types.SimpleNamespace(is_available=lambda: cuda_available)
    torch.no_grad = lambda: mock.MagicMock()
    return torch


class FakeModel:
    """Stands in for tsr.system.TSR: renders n_views images of the requested size."""

    def __init__(self, views):
        self.views, self.renderer = views, types.SimpleNamespace(set_chunk_size=lambda size: None)

    def eval(self):
        pass

    def to(self, device):
        pass

    def __call__(self, images, device=None):
        return ["scene-codes"]

    def render(self, codes, n_views, height, width, return_type):
        return [[view.resize((height, width)) for view in self.views[:n_views]]]


class Availability(unittest.TestCase):
    """A machine without the extras must import cleanly and say so, so 2D try-on keeps serving."""

    def test_without_cuda(self):
        with provisioned_weights(), mock.patch.dict(sys.modules, {"torch": torch_stub(cuda_available=False)}):
            self.assertFalse(reconstruction_3d.available())

    def test_without_weights(self):
        with TemporaryDirectory() as directory, temporary_env(AI_WEIGHTS_DIR=directory):
            with mock.patch.dict(sys.modules, {"torch": torch_stub()}):
                self.assertFalse(reconstruction_3d.available())

    def test_without_vendored_tree(self):
        """The CI image has the weights and a GPU but no /opt/vendor, which is exactly the gap to report."""
        with provisioned_weights(), mock.patch.dict(sys.modules, {"torch": torch_stub()}):
            self.assertFalse(reconstruction_3d._vendor_present())

    def test_frame_count_bounds(self):
        for frames in (0, 11, 37, -3):
            with self.assertRaises(ValueError):
                reconstruction_3d.turntable(Image.new("RGB", (8, 8)), frames=frames)


class Conditioning(unittest.TestCase):
    def test_subject_is_centred_and_scaled_to_the_foreground_ratio(self):
        cutout = Image.new("RGBA", (200, 100), (0, 0, 0, 0))
        for x in range(50, 150):
            for y in range(20, 80):
                cutout.putpixel((x, y), (200, 30, 30, 255))

        conditioned = reconstruction_3d._condition(cutout)

        self.assertEqual(conditioned.mode, "RGB")
        self.assertEqual(conditioned.size[0], conditioned.size[1])
        self.assertGreaterEqual(conditioned.size[0], 100 / reconstruction_3d.FOREGROUND_RATIO)

    def test_empty_matte_is_reported_as_no_subject(self):
        with self.assertRaises(RuntimeError):
            reconstruction_3d._condition(Image.new("RGBA", (32, 32), (0, 0, 0, 0)))


class Turntable(unittest.TestCase):
    views = [Image.new("RGBA", (reconstruction_3d.TILE, reconstruction_3d.TILE),
                 (index * 10 + 5, 40, 60, 255)) for index in range(24)]

    def test_sprite_tiles_every_view_in_reading_order(self):
        from io import BytesIO

        with self._stage():
            result = reconstruction_3d.turntable(Image.new("RGB", (512, 512)))

        self.assertEqual(result["frames"], 24)
        self.assertEqual((result["columns"], result["rows"], result["tile"]), (6, 4, reconstruction_3d.TILE))
        with Image.open(BytesIO(result["sprite"])) as sheet:
            self.assertEqual(sheet.size, (6 * reconstruction_3d.TILE, 4 * reconstruction_3d.TILE))
            for index in (0, 7, 23):
                column, row = index % result["columns"], index // result["columns"]
                edge = reconstruction_3d.TILE
                tile = sheet.crop((column * edge, row * edge, (column + 1) * edge, (row + 1) * edge))
                self.assertGreater(sum(tile.getpixel((edge // 2, edge // 2))[:2]), 0)
                self.assertAlmostEqual(tile.getpixel((edge // 2, edge // 2))[0],
                                 self.views[index].getpixel((edge // 2, edge // 2))[0], delta=1)

    def test_sparse_render_is_a_failure_not_a_short_sheet(self):
        with self._stage(views=self.views[:6]):
            with self.assertRaises(RuntimeError):
                reconstruction_3d.turntable(Image.new("RGB", (512, 512)))

    def _stage(self, views=None):
        return Stage(self, views or Turntable.views)


class Stage:
    """Runs turntable() against stubs: cutout passthrough, fake TSR, no CUDA, weights and vendor tree faked."""

    def __init__(self, case, views):
        self.case, self.views = case, views

    def __enter__(self):
        self.weights = TemporaryDirectory()
        self.weights.__enter__()
        self.environment = temporary_env(AI_WEIGHTS_DIR=self.weights.name)
        self.environment.__enter__()
        root = Path(self.weights.name)
        for artifact in reconstruction_3d.ARTIFACTS:
            target = root / artifact
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(b"stub")
        vendor = root / "vendor" / "tsr"
        vendor.mkdir(parents=True, exist_ok=True)
        (vendor / "system.py").write_text("", encoding="utf-8")
        self.path = list(sys.path)
        sys.path.insert(0, str(root / "vendor"))
        self.patches = [
            mock.patch.object(reconstruction_3d, "_cutout", side_effect=lambda image: image),
            mock.patch.object(reconstruction_3d, "_model", return_value=FakeModel(self.views)),
            mock.patch.dict(sys.modules, {"torch": torch_stub()}),
        ]
        for patch in self.patches:
            patch.start()
        self.addCleanup = None
        return self

    def __exit__(self, *exc):
        for patch in reversed(self.patches):
            patch.stop()
        sys.path[:] = self.path
        self.environment.__exit__(*exc)
        self.weights.__exit__(*exc)
        return False


def temporary_env(**values):
    return mock.patch.dict(os.environ, values, clear=False)


class provisioned_weights:
    """Weights present but no vendor tree, so availability turns on exactly one missing piece."""

    def __enter__(self):
        self.directory = TemporaryDirectory()
        root = Path(self.directory.name)
        for artifact in reconstruction_3d.ARTIFACTS:
            target = root / artifact
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(b"stub")
        self.environment = temporary_env(AI_WEIGHTS_DIR=str(root),
                                        TRIPOSR_IMAGE_TOKENIZER_CONFIG=str(root / "TripoSR" / "image_tokenizer"))
        self.environment.__enter__()
        return self

    def __exit__(self, *exc):
        self.environment.__exit__(*exc)
        self.directory.cleanup()
        return False


if __name__ == "__main__":
    unittest.main()
