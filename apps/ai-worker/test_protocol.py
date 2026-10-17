"""Worker boundary tests prevent consent bypass and private-file traversal."""
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from types import SimpleNamespace
from PIL import Image

from infer import execute, job_file, catalog_batch_images


class ProtocolTests(unittest.TestCase):
    def test_private_files_cannot_escape_job_directory(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for path in ("../private.png", str(root.parent / "private.png"), None, ""):
                with self.assertRaises(ValueError):
                    job_file(root, path)

    def test_try_on_and_enhancement_require_confirmation_before_opening_photo(self):
        with patch("infer.read_image") as decode:
            for task in ("virtual_try_on", "product_image_enhance"):
                with self.assertRaisesRegex(ValueError, "CONSENT_AND_PREVIEW_REQUIRED"):
                    execute(Path("."), {"task": task, "consent": True})
            decode.assert_not_called()

    def test_unsupported_analysis_never_fabricates_result(self):
        with self.assertRaisesRegex(ValueError, "TASK_NOT_SUPPORTED"):
            execute(Path("."), {"task": "personal_color"})

    def test_catalog_batch_cannot_select_private_files_or_exceed_limit(self):
        for images in ([], ['person.image'], ['catalog-0.image'] * 17,
                       ['catalog-0.image', '../secret.image'], [{}]):
            with self.assertRaisesRegex(ValueError, "INVALID_IMAGE_BATCH"):
                execute(Path("."), {"task": "image_embedding", "images": images})

    def test_catalog_source_failure_does_not_block_remaining_images(self):
        self.assertEqual(catalog_batch_images(['catalog-0.image', 'catalog-2.image']),
                         ['catalog-0.image', 'catalog-2.image'])
        with self.assertRaises(ValueError):
            catalog_batch_images(['catalog-0.image', 'catalog-0.image'])

    def test_background_derivative_preserves_foreground_rgb_and_original(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            original = Image.new("RGB", (400, 500), (20, 60, 100))
            original.save(root / "input.png")
            before = (root / "input.png").read_bytes()
            fake_segmenter = SimpleNamespace(new_session=lambda _: object(),
                remove=lambda *args, **kwargs: Image.new("L", (400, 500), 255))
            with patch.dict("sys.modules", {"rembg": fake_segmenter}):
                result = execute(root, {"task": "product_image_enhance", "consent": True,
                    "confirmed": True, "image": "input.png", "options": {"background": "transparent"}})
            self.assertTrue(result["requires_review"])
            self.assertEqual((root / "input.png").read_bytes(), before)
            with Image.open(root / "result.png") as derivative:
                self.assertEqual(derivative.getpixel((10, 10)), (20, 60, 100, 255))


if __name__ == "__main__":
    unittest.main()
