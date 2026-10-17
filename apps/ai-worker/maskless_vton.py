"""Apache-2.0 FASHN sampler adapted by Velura from pipeline.py at
7c0f10af3f91ad4048fe9729c470a13ef905d25a. Only segmentation_free + flat-lay;
no human parser, masking code or noncommercial segmentation dependency is imported.
"""
from pathlib import Path
import threading
import time
import cv2
import numpy as np
import torch
from safetensors.torch import load_file
from fashn_vton.dwpose import DWposeDetector, draw_pose
from fashn_vton.preprocessing.transforms import AspectPreserveResize, ResizePad
from fashn_vton.tryon_mmdit import TryOnModel
from fashn_vton.utils import get_dummy_dw_keypoints, get_rf_schedule, normalize_uint8_to_neg1_1, numpy_to_torch, tensor_to_pil


class InferenceCancelled(Exception):
    """Caller disconnected or the finite sampling deadline elapsed."""


def require_gpu() -> None:
    """Production VTO never falls back to CPU or an unsupported precision."""
    if not torch.cuda.is_available() or not torch.cuda.is_bf16_supported():
        raise RuntimeError("GPU_BF16_REQUIRED")


class MasklessVton:
    """Own the genuine GPU TryOnModel and CPU DWPose; external gate serializes use."""

    def __init__(self, weights: Path):
        require_gpu()
        self.device = torch.device("cuda:0")
        self.dtype = torch.bfloat16
        with torch.device("meta"):
            self.model = TryOnModel()
        self.model.load_state_dict(load_file(str(weights / "model.safetensors"), device="cpu"), assign=True)
        self.model.to(self.device, dtype=self.dtype).eval()
        self.pose = DWposeDetector(checkpoints_dir=str(weights / "dwpose"), device="cpu")
        h, w = self.model.input_shape
        self.pre_resize = AspectPreserveResize((max(h, w), max(h, w)), mode="fit", backend="pil")
        torch.cuda.synchronize()

    @torch.inference_mode()
    def warmup(self) -> None:
        """Execute full-resolution CFG once; loading weights alone is not GPU readiness."""
        h, w = self.model.input_shape
        image = torch.zeros((1, self.model.channels_in, h, w), device=self.device, dtype=self.dtype)
        pose = torch.zeros((1, 1, h, w), device=self.device, dtype=self.dtype)
        prediction = self.model.forward_for_cfg(
            image, torch.zeros((1,), device=self.device, dtype=self.dtype),
            ca_images=image, garment_images=image, person_poses=pose, garment_poses=pose,
            garment_categories=torch.ones((1,), device=self.device, dtype=torch.long))
        if not all(torch.isfinite(value).all().item() for value in prediction.values()):
            raise RuntimeError("GPU_FORWARD_INVALID")
        torch.cuda.synchronize()

    def person_reasons(self, rgb: np.ndarray) -> list[str]:
        """Count all people rather than silently selecting the best detected person."""
        pose = self.pose(rgb[..., ::-1], single=False)
        bodies = pose["bodies"]
        subset = bodies["subset"]
        if len(subset) == 0:
            return ["PERSON_NOT_DETECTED"]
        if len(subset) != 1:
            return ["MULTIPLE_PEOPLE"]
        points = bodies["candidate"]
        # OpenPose keypoints: 2=R-Shoulder, 5=L-Shoulder, 8=R-Hip, 11=L-Hip.
        # Accept upper body photos (shoulders visible) for tops, and full body photos.
        has_shoulders = subset[0, 2] >= 0 and subset[0, 5] >= 0
        has_hips = subset[0, 8] >= 0 and subset[0, 11] >= 0
        if not has_shoulders and not has_hips:
            return ["BODY_CROPPED_OR_OCCLUDED"]
        if has_shoulders and abs(float(points[2, 0] - points[5, 0])) < .08:
            return ["POSE_NOT_FRONTAL"]
        return []

    @torch.inference_mode()
    def infer(self, person, garment, category: str, cancel: threading.Event, deadline: float):
        """Mirror upstream unchanged input branches, pose transforms, Euler CFG and unpad."""
        labels = {"upper_body": 1, "lower_body": 2, "dresses": 3}
        if category not in labels:
            raise ValueError("INVALID_GARMENT_CATEGORY")
        person = self.pre_resize(person, allow_upsampling=False)
        garment = self.pre_resize(garment, allow_upsampling=False)
        person_np, garment_np = np.asarray(person), np.asarray(garment)
        pose = self.pose(person_np[..., ::-1])
        person_pose = draw_pose(pose, person_np.shape[0], person_np.shape[1], grayscale=True)
        garment_pose = draw_pose(get_dummy_dw_keypoints(), garment_np.shape[0], garment_np.shape[1], grayscale=True)
        h, w = self.model.input_shape
        pad = ResizePad((w, h), backend="opencv")
        # Upstream disable_masking=True returns the original person/flat-lay unchanged.
        ca = pad(person_np, mem_padding=True)
        cloth = pad(garment_np)
        pp = pad(person_pose, interpolation=cv2.INTER_NEAREST_EXACT)
        gp = pad(garment_pose, interpolation=cv2.INTER_NEAREST_EXACT)

        def tensor(image):
            if image.ndim == 2:
                image = image[..., None]
            return normalize_uint8_to_neg1_1(numpy_to_torch(image).unsqueeze(0)).to(self.device, dtype=self.dtype)

        kwargs = {"ca_images": tensor(ca), "garment_images": tensor(cloth),
                  "person_poses": tensor(pp), "garment_poses": tensor(gp),
                  "garment_categories": torch.tensor([labels[category]], device=self.device)}
        generator = torch.Generator(device=self.device).manual_seed(42)
        images = torch.randn((1, self.model.channels_in, h, w), generator=generator, device=self.device, dtype=self.dtype)
        times = get_rf_schedule(num_steps=30, mu=1.5)
        for index, (current, previous) in enumerate(zip(times[:-1], times[1:])):
            if cancel.is_set() or time.monotonic() >= deadline:
                raise InferenceCancelled()
            t = torch.full((1,), current, dtype=self.dtype, device=self.device)
            prediction = self.model.forward_for_cfg(images, t, **kwargs)
            conditional, unconditional = prediction["v_c"], prediction["v_u"]
            velocity = conditional if index >= 29 else unconditional + 1.5 * (conditional - unconditional)
            images = images + (previous - current) * velocity
        torch.cuda.synchronize()
        if cancel.is_set() or time.monotonic() >= deadline:
            raise InferenceCancelled()
        return pad.unpad(tensor_to_pil(images[0].float().clamp_(-1, 1), unnormalize=True))
