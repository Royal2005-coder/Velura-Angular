"""Prepare one reproducible Leffa worker environment through colab exec; no web tunnel."""
import json
from pathlib import Path
import subprocess
import sys
from urllib.request import urlretrieve

ROOT = Path("/content/velura-ai")
SOURCE_REVISION = "05a259104b6927607776c7edb3e86b75406f20aa"
WEIGHTS_REVISION = "61d3390f444506f052feedb0b243cd5369c29c89"


def run(*args):
    """Fail setup immediately instead of advertising a partially installed worker."""
    subprocess.run(args, check=True)


ROOT.mkdir(parents=True, exist_ok=True)
pose_model = ROOT / "pose_landmarker_lite.task"
if not pose_model.exists():
    urlretrieve("https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task", pose_model)
repo = ROOT / "Leffa"
if not (repo / ".git").exists():
    run("git", "clone", "https://github.com/franciszzj/Leffa.git", str(repo))
run("git", "-C", str(repo), "checkout", "--detach", SOURCE_REVISION)
run(sys.executable, "-m", "pip", "install", "uv==0.9.3")
run(sys.executable, "-m", "uv", "python", "install", "3.10")
venv = ROOT / ".venv"
if not (venv / "bin/python").exists():
    run(sys.executable, "-m", "uv", "venv", "--python", "3.10", str(venv))
python = str(venv / "bin/python")
run(sys.executable, "-m", "uv", "pip", "install", "--python", python,
    "torch==2.4.1", "torchvision==0.19.1", "torchaudio==2.4.1",
    "--index-url", "https://download.pytorch.org/whl/cu121")
run(sys.executable, "-m", "uv", "pip", "install", "--python", python,
    "diffusers==0.31.0", "transformers==4.46.3", "accelerate==1.1.1",
    "peft==0.13.2", "huggingface-hub==0.26.5", "numpy==1.26.4",
    "Pillow==11.3.0", "opencv-python-headless==4.11.0.86", "mediapipe==0.10.21",
    "onnxruntime==1.20.1", "omegaconf==2.3.0", "einops==0.8.0",
    "fvcore==0.1.5.post20221221", "pycocotools==2.0.8", "scipy==1.14.1",
    "scikit-image==0.24.0", "timm==1.0.12", "matplotlib==3.9.4",
    "open-clip-torch==2.29.0", "safetensors==0.4.5", "rembg==2.0.61",
    "av==12.3.0", "cloudpickle==3.1.1", "psutil==7.1.0", "pandas==2.2.3")
freeze = subprocess.run([sys.executable, "-m", "uv", "pip", "freeze", "--python", python],
                        check=True, capture_output=True, text=True).stdout
(ROOT / "installed-requirements.txt").write_text(freeze)
# Only required inference weights; never load pose-transfer and both VTON models together.
download = "\n".join([
    "from huggingface_hub import snapshot_download",
    f"snapshot_download(repo_id='franciszzj/Leffa', revision='{WEIGHTS_REVISION}',",
    f"local_dir={str(repo / 'ckpts')!r}, allow_patterns=[",
    "'stable-diffusion-inpainting/*', 'virtual_tryon_dc.pth', 'densepose/*',",
    "'humanparsing/*', 'openpose/*', 'examples/person1/*', 'examples/garment/*'])",
])
run(python, "-c", download)
print(json.dumps({"environment_installed": True, "inference_verified": False,
                  "source_revision": SOURCE_REVISION, "weights_revision": WEIGHTS_REVISION,
                  "python": python}))
