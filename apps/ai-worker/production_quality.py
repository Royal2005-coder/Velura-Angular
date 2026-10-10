"""Measured CPU gates; calibration remains an explicit deployment acceptance requirement."""
import math
from image_gate import assess


def quality(image, person=False, pose_detector=None) -> dict:
    """Report actual photometric/pose measurements with a versioned border heuristic score."""
    gate = assess(image, person=person, pose_detector=pose_detector)
    score = math.exp(-gate["metrics"]["border_variance"] / 45)
    gate["metrics"]["background_score"] = round(score, 6)
    if score < .5:
        gate.setdefault("warnings", []).append("BACKGROUND_TOO_COMPLEX")
    fatal = {"PERSON_NOT_DETECTED", "TOO_DARK", "OVEREXPOSED", "BLURRY", "LOW_RESOLUTION", "MULTIPLE_PEOPLE"}
    gate["valid"] = not any(reason in fatal for reason in gate["reasons"])
    gate["threshold_version"] = "velura-measured-1"
    gate["calibration_status"] = "requires_licensed_validation_dataset"
    gate["background_check"] = "border_uniformity_heuristic_v1"
    return gate


class CpuQuality:
    """Quality remains available before GPU/model provisioning; no pose success is fabricated."""

    def __init__(self):
        """Prove CPU imaging dependencies execute before advertising a routable task."""
        from PIL import Image
        measured = quality(Image.new("RGB", (384, 384), (128, 128, 128)))
        if not all(math.isfinite(value) for value in measured["metrics"].values()):
            raise RuntimeError("CPU_QUALITY_UNAVAILABLE")

    quality = staticmethod(quality)
