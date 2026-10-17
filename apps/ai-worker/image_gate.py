"""CPU checks before paid image inference; thresholds are provisional MVP settings."""
from io import BytesIO
from pathlib import Path
import warnings
import os

import numpy as np
from PIL import Image, ImageOps

MAX_BYTES = 10 * 1024 * 1024
MAX_PIXELS = 20_000_000
Image.MAX_IMAGE_PIXELS = MAX_PIXELS


def read_image(path: Path) -> Image.Image:
    """Decode bounded JPEG/PNG/WebP content, normalize orientation and discard metadata."""
    payload = path.read_bytes()
    if not payload or len(payload) > MAX_BYTES:
        raise ValueError("IMAGE_SIZE")
    with warnings.catch_warnings():
        warnings.simplefilter("error", Image.DecompressionBombWarning)
        with Image.open(BytesIO(payload)) as image:
            if image.format not in {"JPEG", "PNG", "WEBP"}:
                raise ValueError("IMAGE_FORMAT")
            if getattr(image, "n_frames", 1) != 1:
                raise ValueError("ANIMATED_IMAGE")
            if image.width * image.height > MAX_PIXELS:
                raise ValueError("IMAGE_PIXELS")
            image.load()
            return ImageOps.exif_transpose(image).convert("RGB")


def assess(image: Image.Image, person: bool = False, pose_detector=None) -> dict:
    """Report measured reasons; never mistake a CPU brightness check for a pose check."""
    import cv2

    thumbnail = image.copy()
    thumbnail.thumbnail((768, 1024))
    rgb = np.asarray(thumbnail)
    gray = cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY)
    brightness = float(gray.mean())
    sharpness = float(cv2.Laplacian(gray, cv2.CV_64F).var())
    border = np.concatenate([rgb[0], rgb[-1], rgb[:, 0], rgb[:, -1]])
    border_variance = float(border.std(axis=0).mean())
    reasons = []
    if min(image.size) < 384:
        reasons.append("LOW_RESOLUTION")
    if brightness < 45:
        reasons.append("TOO_DARK")
    if brightness > 235:
        reasons.append("OVEREXPOSED")
    if sharpness < 35:
        reasons.append("BLURRY")
    pose_checked = False
    if person:
        if pose_detector is None:
            reasons.append("POSE_CHECK_UNAVAILABLE")
        else:
            pose_checked = True
            pose_reasons = pose_detector(rgb)
            reasons.extend(pose_reasons)
            if "POSE_CHECK_UNAVAILABLE" in pose_reasons:
                pose_checked = False
    return {
        "valid": not reasons,
        "reasons": list(dict.fromkeys(reasons)),
        "suggested_mode": "studio" if person and reasons else "personal",
        "metrics": {"width": image.width, "height": image.height,
                    "brightness": round(brightness, 2), "sharpness": round(sharpness, 2),
                    "border_variance": round(border_variance, 2)},
        "pose_checked": pose_checked,
        "background_check": "border_heuristic_only",
        "threshold_version": "mvp-1-unvalidated",
    }


def mediapipe_pose_detector(rgb: np.ndarray, category: str = "upper_body") -> list[str]:
    """Detect up to two poses and reject multiple people before validating the dressed region."""
    import mediapipe as mp
    asset = Path(os.environ.get("AI_POSE_MODEL", "/content/velura-ai/pose_landmarker_lite.task"))
    if not asset.is_file():
        return ["POSE_CHECK_UNAVAILABLE"]
    options = mp.tasks.vision.PoseLandmarkerOptions(
        base_options=mp.tasks.BaseOptions(model_asset_path=str(asset)),
        running_mode=mp.tasks.vision.RunningMode.IMAGE,
        num_poses=2, min_pose_detection_confidence=0.6, min_pose_presence_confidence=0.6,
        output_segmentation_masks=True)
    with mp.tasks.vision.PoseLandmarker.create_from_options(options) as detector:
        result = detector.detect(mp.Image(image_format=mp.ImageFormat.SRGB,
                                         data=np.ascontiguousarray(rgb)))
    reasons = validate_pose_landmarks(result.pose_landmarks, category)
    if len(result.pose_landmarks) == 1:
        if not result.segmentation_masks:
            reasons.append("BACKGROUND_CHECK_UNAVAILABLE")
        else:
            mask = result.segmentation_masks[0].numpy_view()
            background = rgb[mask < 0.1]
            if len(background) < rgb.shape[0] * rgb.shape[1] * 0.03:
                reasons.append("BACKGROUND_NOT_VISIBLE")
            elif float(background.std(axis=0).mean()) > 45:
                reasons.append("BACKGROUND_TOO_COMPLEX")
    return reasons


def validate_pose_landmarks(poses: list, category: str) -> list[str]:
    """Keep category/count rules independently testable from model inference."""
    if not poses:
        return ["PERSON_NOT_DETECTED"]
    if len(poses) != 1:
        return ["MULTIPLE_PEOPLE"]
    points = poses[0]
    if len(points) < 27:
        return ["BODY_CROPPED_OR_OCCLUDED"]
    # Upper-body inputs follow VITON-HD's torso crop; knees matter for bottoms/dresses.
    required = (11, 12, 23, 24) if category == "upper_body" else (11, 12, 23, 24, 25, 26)
    if any(points[i].visibility < 0.6 or not 0.02 <= points[i].x <= 0.98
           or not 0.02 <= points[i].y <= 0.98 for i in required):
        return ["BODY_CROPPED_OR_OCCLUDED"]
    if abs(points[11].x - points[12].x) < 0.1:
        return ["POSE_NOT_FRONTAL"]
    return []
