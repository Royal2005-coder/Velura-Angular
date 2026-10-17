"""Versioned private inference boundary; identifiers bind bytes to the authorized job."""
import base64
from io import BytesIO
import json
import re
import warnings
from PIL import Image, ImageOps

VERSION = "velura-worker-v1"
TASKS = {"/ai/quality": "image_quality", "/embed/image": "image_embedding",
         "/ai/enhance": "product_image_enhance", "/ai/try-on": "virtual_try_on"}
MAX_PIXELS = 12_000_000
UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.I)
Image.MAX_IMAGE_PIXELS = MAX_PIXELS


def binding(raw: str, task: str) -> dict:
    """Reject semantic task mismatches and invalid product/variant ownership identifiers."""
    if len(raw) > 1024:
        raise ValueError("INVALID_BINDING")
    value = json.loads(raw)
    required = {"schema_version", "request_id", "task", "product_id", "variant_id", "image_id"}
    if not isinstance(value, dict) or set(value) != required or value["schema_version"] != VERSION or value["task"] != task:
        raise ValueError("INVALID_BINDING")
    if not isinstance(value["request_id"], str) or not UUID.fullmatch(value["request_id"]):
        raise ValueError("INVALID_REQUEST_ID")
    for field in ("product_id", "variant_id"):
        if not isinstance(value[field], str) or (value[field] and not UUID.fullmatch(value[field])):
            raise ValueError("INVALID_BINDING_ID")
    if value["variant_id"] and not value["product_id"]:
        raise ValueError("INVALID_VARIANT_BINDING")
    if not isinstance(value["image_id"], str) or not re.fullmatch(r"[a-zA-Z0-9_.-]{1,100}", value["image_id"]):
        raise ValueError("INVALID_IMAGE_ID")
    if task == "virtual_try_on" and not (value["product_id"] and value["variant_id"]):
        raise ValueError("PRODUCT_VARIANT_REQUIRED")
    return value


def encoded(value: dict) -> str:
    """Encode compact JSON for bounded response headers without raw paths/images."""
    return base64.urlsafe_b64encode(json.dumps(value, separators=(",", ":"), allow_nan=False).encode()).decode()


def decode(payload: bytes, max_bytes: int):
    """Decode actual raster content, bound memory and drop EXIF/location metadata."""
    if not payload or len(payload) > max_bytes:
        raise ValueError("IMAGE_SIZE")
    with warnings.catch_warnings():
        warnings.simplefilter("error", Image.DecompressionBombWarning)
        with Image.open(BytesIO(payload)) as image:
            if image.format not in {"PNG", "JPEG", "WEBP"} or getattr(image, "n_frames", 1) != 1:
                raise ValueError("IMAGE_FORMAT")
            if image.width * image.height > MAX_PIXELS:
                raise ValueError("IMAGE_PIXELS")
            image.load()
            return ImageOps.exif_transpose(image).convert("RGB")
