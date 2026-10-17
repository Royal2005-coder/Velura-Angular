"""Local-only model loaders and measured quality/color preservation output gates."""
from io import BytesIO
from pathlib import Path
import cv2
import numpy as np
from PIL import Image, ImageEnhance
from bootstrap_weights import verify_weights
from production_quality import quality
from production_protocol import VERSION


class ProductionModels:
    """Load verified local VTO GPU, CLIP CPU and Apache U2Net CPU dependencies."""

    def __init__(self, weights: Path):
        verify_weights(weights)
        import torch
        import open_clip
        import onnxruntime as ort
        from maskless_vton import MasklessVton
        torch.set_num_threads(2)
        self.vton = MasklessVton(weights)
        self.clip, _, self.preprocess = open_clip.create_model_and_transforms(
            "ViT-B-32", pretrained=str(weights / "clip/open_clip_model.safetensors"), device="cpu",
            image_mean=(.48145466, .4578275, .40821073), image_std=(.26862954, .26130258, .27577711),
            image_interpolation="bicubic", image_resize_mode="shortest")
        self.clip.eval()
        options = ort.SessionOptions()
        options.intra_op_num_threads = 2
        options.inter_op_num_threads = 1
        self.u2net = ort.InferenceSession(str(weights / "u2net.onnx"), sess_options=options,
                                         providers=["CPUExecutionProvider"])
        # Loading plus actual tiny dependency executions must succeed before readiness.
        with torch.inference_mode():
            self.clip.encode_image(self.preprocess(Image.new("RGB", (224, 224))).unsqueeze(0))
        self.u2net.run(None, {self.u2net.get_inputs()[0].name: np.zeros((1, 3, 320, 320), dtype=np.float32)})
        self.vton.pose(np.zeros((256, 256, 3), dtype=np.uint8), single=False)
        self.vton.warmup()
        self.health = {"schema_version": VERSION, "ready": True, "gpu": True, "dtype": "bfloat16",
                       "gpu_forward_verified": True, "smoke_verified": False,
                       "vton_model": "fashn-vton-1.5-maskless-flatlay", "embedding_model": "openclip-vit-b32-laion2b",
                       "dimensions": 512, "garment_photo_types": ["flat-lay"], "segmentation_free": True,
                       "tasks": {task: True for task in ("image_quality", "image_embedding", "virtual_try_on", "product_image_enhance")}}

    def quality(self, image, person: bool) -> dict:
        """Use measured decode/photometric gate and real pose count when requested."""
        return quality(image, person=person, pose_detector=self.vton.person_reasons)

    def embedding(self, image) -> list[float]:
        """Return the existing namespace's genuine normalized 512-dimensional CLIP vector."""
        import torch
        with torch.inference_mode():
            vector = self.clip.encode_image(self.preprocess(image).unsqueeze(0))
            norm = vector.norm(dim=-1, keepdim=True)
            if not torch.isfinite(vector).all() or norm.item() <= 0:
                raise ValueError("EMBEDDING_INVALID")
            values = (vector / norm).float().squeeze(0).tolist()
        if len(values) != 512:
            raise ValueError("EMBEDDING_DIMENSIONS")
        return values

    def enhance(self, image, background: str, brightness: bool, sharpness: bool):
        """Apache U2Net mask + bounded luminance/sharpness only; reject hue drift."""
        # Matches rembg U2Net's max-normalized RGB/ImageNet 320x320 preprocessing.
        pixels = np.asarray(image.resize((320, 320), Image.Resampling.LANCZOS)).astype(np.float32)
        maximum = float(pixels.max())
        if maximum <= 0:
            raise ValueError("ENHANCEMENT_INPUT_EMPTY")
        pixels = pixels / maximum
        pixels = (pixels - np.array([.485, .456, .406], dtype=np.float32)) / np.array([.229, .224, .225], dtype=np.float32)
        tensor = np.transpose(pixels, (2, 0, 1))[None]
        prediction = self.u2net.run(None, {self.u2net.get_inputs()[0].name: tensor})[0][:, 0, :, :].squeeze()
        span = float(prediction.max() - prediction.min())
        if not np.isfinite(prediction).all() or span <= 1e-6:
            raise ValueError("FOREGROUND_UNAVAILABLE")
        mask = Image.fromarray(((prediction - prediction.min()) / span * 255).astype(np.uint8)).resize(image.size, Image.Resampling.LANCZOS)
        foreground = np.asarray(mask) > 230
        fraction = float(foreground.mean())
        if fraction < .03 or fraction > .98:
            raise ValueError("FOREGROUND_INVALID")
        corrected = image
        if brightness:
            mean = float(cv2.cvtColor(np.asarray(image), cv2.COLOR_RGB2GRAY)[foreground].mean())
            corrected = ImageEnhance.Brightness(corrected).enhance(min(1.08, max(.95, 150 / max(mean, 1))))
        if sharpness:
            corrected = ImageEnhance.Sharpness(corrected).enhance(1.15)
        before_hsv = cv2.cvtColor(np.asarray(image), cv2.COLOR_RGB2HSV).astype(np.float32)
        after_hsv = cv2.cvtColor(np.asarray(corrected), cv2.COLOR_RGB2HSV).astype(np.float32)
        colorful = foreground & (before_hsv[:, :, 1] > 30)
        delta = np.abs(before_hsv[:, :, 0] - after_hsv[:, :, 0])
        hue_shift = float(np.minimum(delta, 180 - delta)[colorful].mean() * 2) if colorful.any() else 0.0
        if hue_shift > 2:
            raise ValueError("ENHANCEMENT_COLOR_DRIFT")
        output = corrected.convert("RGBA")
        output.putalpha(mask)
        if background == "white":
            base = Image.new("RGBA", output.size, "white")
            base.alpha_composite(output)
            output = base.convert("RGB")
        gate = self.quality(corrected, False)
        gate.update({"foreground_fraction": round(fraction, 4), "mean_foreground_hue_shift_degrees": round(hue_shift, 4),
                     "background": background, "model": "u2net-apache2", "color_preserved": True})
        return output, gate


def png(image) -> bytes:
    """Encode a metadata-free bounded PNG, never publish the original source bytes."""
    stream = BytesIO()
    image.save(stream, format="PNG")
    payload = stream.getvalue()
    if len(payload) > 8 * 1024 * 1024:
        raise ValueError("OUTPUT_TOO_LARGE")
    return payload
