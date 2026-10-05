"""Private file-based worker protocol; public web APIs remain Node TypeScript.

Colab CLI uploads a job directory, executes this worker, and downloads its outputs.
No browser receives a Colab token and no arbitrary URL or callback is executed.
"""
import argparse
import json
import os
from pathlib import Path
import sys
import gc

# The Colab kernel's notebook backend is not installed in the private worker venv.
os.environ["MPLBACKEND"] = "Agg"

import numpy as np
from PIL import Image
from PIL import ImageEnhance
from image_gate import assess, mediapipe_pose_detector, read_image

LEFFA_ROOT = Path(os.environ.get("LEFFA_ROOT", "/content/velura-ai/Leffa"))


def job_file(root: Path, name: str) -> Path:
    """Restrict all input/output files to the uploaded job directory."""
    if not isinstance(name, str) or not name or Path(name).is_absolute():
        raise ValueError("INVALID_IMAGE_PATH")
    candidate = (root / name).resolve()
    if not candidate.is_relative_to(root.resolve()):
        raise ValueError("INVALID_IMAGE_PATH")
    return candidate


def virtual_try_on(root: Path, job: dict) -> dict:
    """Load only DressCode VTON; studio uses a confirmed licensed person asset."""
    if job.get("consent") is not True or job.get("confirmed") is not True:
        raise ValueError("CONSENT_AND_PREVIEW_REQUIRED")
    category = job.get("garment_category")
    if category not in {"upper_body", "lower_body", "dresses"}:
        raise ValueError("UNSUPPORTED_GARMENT_CATEGORY")
    if job.get("mode") not in {"personal", "studio"}:
        raise ValueError("INVALID_MODE")
    person = read_image(job_file(root, job.get("person")))
    garment = read_image(job_file(root, job.get("garment")))
    gate = assess(person, person=True,
                  pose_detector=lambda rgb: mediapipe_pose_detector(rgb, category))
    gate["background_check"] = "pose_segmentation_provisional" if gate["pose_checked"] else "unavailable"
    if not gate["valid"]:
        return {"status": "validation_failed", "gate": gate}
    # Strip EXIF/private metadata before passing user content to model preprocessing.
    person.save(root / "normalized-person.png")
    garment.save(root / "normalized-garment.png")
    import torch
    if not torch.cuda.is_available():
        raise RuntimeError("GPU_UNAVAILABLE")
    sys.path.insert(0, str(LEFFA_ROOT))
    os.chdir(LEFFA_ROOT)
    from leffa.model import LeffaModel
    from leffa.inference import LeffaInference
    from leffa.transform import LeffaTransform
    from leffa_utils.densepose_predictor import DensePosePredictor
    from leffa_utils.utils import resize_and_center, get_agnostic_mask_dc
    from preprocess.humanparsing.run_parsing import Parsing
    from preprocess.openpose.run_openpose import OpenPose

    person = resize_and_center(person, 768, 1024)
    garment = resize_and_center(garment, 768, 1024)
    parsing = Parsing(atr_path="./ckpts/humanparsing/parsing_atr.onnx",
                      lip_path="./ckpts/humanparsing/parsing_lip.onnx")
    pose = OpenPose(body_model_path="./ckpts/openpose/body_pose_model.pth")
    densepose = DensePosePredictor(
        config_path="./ckpts/densepose/densepose_rcnn_R_50_FPN_s1x.yaml",
        weights_path="./ckpts/densepose/model_final_162be9.pkl")
    model_parse, _ = parsing(person.resize((384, 512)))
    mask = get_agnostic_mask_dc(model_parse, pose(person.resize((384, 512))), category)
    iuv = densepose.predict_iuv(np.asarray(person))
    dense = Image.fromarray(np.repeat(iuv[:, :, 0:1], 3, axis=-1))
    data = LeffaTransform()({"src_image": [person], "ref_image": [garment],
                            "mask": [mask.resize((768, 1024))], "densepose": [dense]})
    # Release pose/parsing models before claiming GPU memory for the diffusion model.
    del parsing, pose, densepose
    gc.collect()
    torch.cuda.empty_cache()
    from accelerate import init_empty_weights
    # Standard T4 Colab lacks RAM for both initialized fp32 UNets and a full checkpoint copy.
    # Build parameter shapes on meta, memory-map trusted pinned weights, assign fp16 on GPU.
    with init_empty_weights():
        model = LeffaModel(pretrained_model_name_or_path="./ckpts/stable-diffusion-inpainting",
                           pretrained_model="", dtype="float16")
    checkpoint = torch.load("./ckpts/virtual_tryon_dc.pth", map_location="cpu",
                            mmap=True, weights_only=True)
    state = {key: tensor.to(device="cuda", dtype=torch.float16 if tensor.is_floating_point() else tensor.dtype)
             for key, tensor in checkpoint.items()}
    model.load_state_dict(state, assign=True)
    del checkpoint, state
    gc.collect()
    with torch.inference_mode():
        result = LeffaInference(model=model)(data, ref_acceleration=True,
                    num_inference_steps=30, guidance_scale=2.5, seed=42, repaint=False)
    result["generated_image"][0].convert("RGB").save(root / "result.png")
    return {"status": "success", "result_file": "result.png", "model": "leffa-dresscode-fp16",
            "mode": job["mode"], "simulation_only": True, "gate": gate}


def catalog_batch_images(batch: list) -> list[str]:
    """Allow gaps when a shop source fails preparation, but reject duplicates and private files."""
    if not isinstance(batch, list) or not 1 <= len(batch) <= 16:
        raise ValueError("INVALID_IMAGE_BATCH")
    allowed = {f"catalog-{index}.image" for index in range(16)}
    if any(not isinstance(name, str) or name not in allowed for name in batch):
        raise ValueError("INVALID_IMAGE_BATCH")
    if len(set(batch)) != len(batch):
        raise ValueError("INVALID_IMAGE_BATCH")
    return batch


def embedding(root: Path, job: dict) -> dict:
    """Produce normalized CLIP image vectors in a separate 512-dimensional namespace."""
    batch = catalog_batch_images(job["images"]) if job.get("images") is not None else [job.get("image")]
    import open_clip
    import torch
    device = "cuda" if torch.cuda.is_available() else "cpu"
    model, _, preprocess = open_clip.create_model_and_transforms(
        "ViT-B-32", pretrained="laion2b_s34b_b79k", device=device)
    model.eval()
    rows = []
    for start in range(0, len(batch), 4):
        tensors, names = [], []
        for name in batch[start:start + 4]:
            try:
                tensors.append(preprocess(read_image(job_file(root, name))))
                names.append(name)
            except (ValueError, OSError):
                rows.append({"image": name, "error_code": "INVALID_CATALOG_IMAGE"})
        if not tensors:
            continue
        with torch.inference_mode():
            vectors = model.encode_image(torch.stack(tensors).to(device))
            vectors = vectors / vectors.norm(dim=-1, keepdim=True)
        rows.extend({"image": name, "embedding": vector.float().cpu().tolist()}
                    for name, vector in zip(names, vectors))
    result = {"status": "success", "model": "openclip-vit-b32-laion2b", "dimensions": 512}
    if job.get("images") is not None:
        return {**result, "batch_embeddings": rows}
    if not rows or "embedding" not in rows[0]:
        raise ValueError("INVALID_IMAGE")
    return {**result, "embedding": rows[0]["embedding"]}


def enhance_product(root: Path, job: dict) -> dict:
    """Generate a reviewable derivative; never change the original or publish it."""
    if job.get("consent") is not True or job.get("confirmed") is not True:
        raise ValueError("CONSENT_AND_PREVIEW_REQUIRED")
    image = read_image(job_file(root, job.get("image")))
    options = job.get("options", {})
    if not isinstance(options, dict):
        raise ValueError("INVALID_OPTIONS")
    background = options.get("background")
    if background not in {None, "white", "transparent"}:
        raise ValueError("INVALID_BACKGROUND")
    if any(options.get(key, False) not in (True, False) for key in ("brightness", "sharpness")):
        raise ValueError("INVALID_OPTIONS")
    if not background and not options.get("brightness") and not options.get("sharpness"):
        raise ValueError("ENHANCEMENT_OPTION_REQUIRED")
    before = assess(image)
    if options.get("brightness"):
        # Conservative user-selected adjustment; not a generated fabric recoloring.
        image = ImageEnhance.Brightness(image).enhance(1.08)
    if options.get("sharpness"):
        image = ImageEnhance.Sharpness(image).enhance(1.15)
    methods = []
    if background:
        from rembg import new_session, remove
        mask = remove(image, session=new_session("u2net"), only_mask=True)
        if mask.getextrema()[1] == 0:
            raise ValueError("FOREGROUND_NOT_DETECTED")
        if background == "transparent":
            image = image.convert("RGBA")
            image.putalpha(mask)
        else:
            image = Image.composite(image, Image.new("RGB", image.size, "white"), mask)
        methods.append("u2net-segmentation")
    if options.get("brightness"):
        methods.append("bounded-brightness-adjustment")
    if options.get("sharpness"):
        methods.append("bounded-sharpness-adjustment")
    image.save(root / "result.png")
    return {"status": "success", "result_file": "result.png", "methods": methods,
            "requires_review": True, "original_preserved": True, "before": before,
            "after": assess(image.convert("RGB"))}


def execute(root: Path, job: dict) -> dict:
    """Dispatch supported tasks; unavailable analysis never fabricates an AI result."""
    task = job.get("task")
    if task == "virtual_try_on":
        return virtual_try_on(root, job)
    if task == "image_embedding":
        return embedding(root, job)
    if task == "product_image_enhance":
        return enhance_product(root, job)
    if task == "image_quality":
        gate = assess(read_image(job_file(root, job.get("image"))),
                 person=job.get("person_check") is True,
                 pose_detector=mediapipe_pose_detector if job.get("person_check") is True else None)
        if job.get("person_check") is True:
            gate["background_check"] = "pose_segmentation_provisional" if gate["pose_checked"] else "unavailable"
        return {"status": "success", "gate": gate}
    raise ValueError("TASK_NOT_SUPPORTED")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("job_dir", type=Path)
    args = parser.parse_args()
    root = args.job_dir.resolve()
    try:
        result = execute(root, json.loads((root / "job.json").read_text()))
    except Exception as error:
        result = {"status": "failed", "error_code": type(error).__name__}
        # Detailed errors stay in private runtime logs, not public customer responses.
        print(f"Worker failure: {error}", file=sys.stderr)
    (root / "result.json").write_text(json.dumps(result))
