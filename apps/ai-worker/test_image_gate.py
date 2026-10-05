"""Safety/suitability regressions use synthetic non-personal fixtures."""
import tempfile
import unittest
from pathlib import Path

import numpy as np
from PIL import Image
from image_gate import assess, read_image, validate_pose_landmarks
from types import SimpleNamespace


class ImageGateTests(unittest.TestCase):
    def test_dark_picture_warns_instead_of_claiming_try_on_ready(self):
        result = assess(Image.new("RGB", (768, 1024), "black"), person=True,
                        pose_detector=lambda _: ["PERSON_NOT_DETECTED"])
        self.assertFalse(result["valid"])
        self.assertIn("TOO_DARK", result["reasons"])
        self.assertIn("PERSON_NOT_DETECTED", result["reasons"])
        self.assertEqual(result["suggested_mode"], "studio")

    def test_missing_pose_detector_never_passes_person_validation(self):
        rng = np.random.default_rng(1)
        photo = Image.fromarray(rng.integers(50, 200, (1024, 768, 3), dtype=np.uint8))
        result = assess(photo, person=True)
        self.assertFalse(result["valid"])
        self.assertFalse(result["pose_checked"])
        self.assertIn("POSE_CHECK_UNAVAILABLE", result["reasons"])

    def test_decode_uses_content_not_filename_and_rejects_animation(self):
        with tempfile.TemporaryDirectory() as root:
            disguised = Path(root) / "fake.jpg"
            disguised.write_text("not an image")
            with self.assertRaises(OSError):
                read_image(disguised)
            image = Image.new("RGB", (400, 500), "white")
            image.save(disguised, format="PNG")
            decoded = read_image(disguised)
            self.assertEqual(decoded.size, (400, 500))
            self.assertFalse(decoded.info)
            frames = [Image.new("RGB", (400, 500), color) for color in ("white", "black")]
            frames[0].save(disguised, format="PNG", save_all=True, append_images=frames[1:])
            with self.assertRaisesRegex(ValueError, "ANIMATED_IMAGE"):
                read_image(disguised)

    def test_provisional_metrics_do_not_claim_ai_background_segmentation(self):
        result = assess(Image.new("RGB", (100, 100), "gray"))
        self.assertIn("LOW_RESOLUTION", result["reasons"])
        self.assertEqual(result["background_check"], "border_heuristic_only")

    def test_multiple_people_are_rejected_and_lower_body_requires_visible_knees(self):
        pose = [SimpleNamespace(x=0.5, y=0.5, visibility=1.0) for _ in range(33)]
        pose[11].x = 0.3
        pose[12].x = 0.7
        self.assertEqual(validate_pose_landmarks([pose, pose], "upper_body"), ["MULTIPLE_PEOPLE"])
        pose[25].visibility = 0.1
        self.assertEqual(validate_pose_landmarks([pose], "upper_body"), [])
        self.assertEqual(validate_pose_landmarks([pose], "lower_body"), ["BODY_CROPPED_OR_OCCLUDED"])


if __name__ == "__main__":
    unittest.main()
