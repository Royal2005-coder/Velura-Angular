"""Assemble the MIT-licensed TripoSR inference tree, with only the patches this image can build.

`VAST-AI-Research/TripoSR` ships no packaging metadata, so it cannot be pip-installed; the tree is
fetched at a pinned revision, verified against upstream git blob ids and then patched:

- `torchmcubes` (a CUDA extension that needs a compiler) becomes scikit-image's CPU mesher.
- `omegaconf` becomes `tsr_config`, because its antlr runtime publishes no wheel.
- `rembg` and `imageio` imports move inside the two functions that use them; the cutout is ours
  (Apache-2.0 u2net through onnxruntime) and the NeRF video writer is never called.
- the DINO-ViT architecture file loads from the provisioned PVC instead of the hub, since the worker
  pod has no egress.

`tsr/bake_texture.py` is deliberately excluded: it needs xatlas plus an OpenGL context, and the mesh
keeps vertex colours, which is what the turntable renders.
"""

import hashlib
import re
from pathlib import Path
import urllib.request

REVISION = "107cefdc244c39106fa830359024f6a2f1c78871"
BLOBS = {
    "LICENSE": "6c440ca1ef32cedcc2257b99953add129199ed26",
    "tsr/system.py": "bcdb69b2e5c85b3c0ffebd7ff82fc4fe7b3d543e",
    "tsr/utils.py": "9758f2e44cd4091f2124929edc89b59e98fff667",
    "tsr/models/isosurface.py": "076321b81f573ab95a6c7d5328f6366e0f33c38e",
    "tsr/models/nerf_renderer.py": "0cf3ab6e31f79c3af8e75384f48c0e874621c2b8",
    "tsr/models/network_utils.py": "470c92b9a99901e93dee2b98e80eea53cfdf3f9d",
    "tsr/models/tokenizers/image.py": "d4034b25a7b2e8f38630fd69a0bae75ed2a5edb0",
    "tsr/models/tokenizers/triplane.py": "ecdd7fd2201c974bb70b18a90a633287b814886f",
    "tsr/models/transformer/attention.py": "34bd99778ce168cb68192c183814f098a3d08e67",
    "tsr/models/transformer/basic_transformer_block.py": "1ea41b0192b6fbb368fe3a587b7c04b0253d23b3",
    "tsr/models/transformer/transformer_1d.py": "a98d0fb98136ea873aef708717a809e434e7ca14",
}

CONFIG_IMPORT = "from tsr_config import DictConfig, OmegaConf"
MARCHING_CUBES = '''from skimage.measure import marching_cubes as _scikit_marching_cubes


def marching_cubes(grid, threshold: float = 0.0):
    """CPU mesher with the tensor signature the CUDA extension had, so `tsr` keeps calling it unchanged."""
    vertices, faces, _, _ = _scikit_marching_cubes(
        np.ascontiguousarray(grid.detach().cpu().numpy(), dtype=np.float32), level=float(threshold)
    )
    return (torch.from_numpy(vertices.astype(np.float32)), torch.from_numpy(faces.astype(np.int64)))
'''

PATCHES = {
    "tsr/utils.py": [
        ("import imageio\nimport numpy as np\nimport PIL.Image\nimport rembg\nimport torch",
         "import numpy as np\nimport PIL.Image\nimport torch"),
        ("from omegaconf import DictConfig, OmegaConf", CONFIG_IMPORT),
        ("    if do_remove:\n        image = rembg.remove(",
         "    if do_remove:\n        import rembg\n\n        image = rembg.remove("),
        ("    # use imageio to save video\n    frames = [np.array(frame) for frame in frames]",
         "    # use imageio to save video\n    import imageio\n\n    frames = [np.array(frame) for frame in frames]"),
    ],
    "tsr/system.py": [
        ("from omegaconf import OmegaConf", "from tsr_config import OmegaConf"),
        ("import math\nimport os\n", "import gc\nimport math\nimport os\n"),
        ("from .models.isosurface import MarchingCubeHelper",
         "from triposr_state_dict import remap\n\nfrom .models.isosurface import MarchingCubeHelper"),
        ("""        ckpt = torch.load(weight_path, map_location="cpu")
        model.load_state_dict(ckpt)
        return model""",
         """        ckpt = torch.load(weight_path, map_location="cpu", weights_only=True)
        model.load_state_dict(remap(ckpt))
        del ckpt
        gc.collect()
        return model"""),
    ],
    "tsr/models/isosurface.py": [
        ("from torchmcubes import marching_cubes", MARCHING_CUBES.strip("\n")),
    ],
    "tsr/models/tokenizers/image.py": [
        ("from dataclasses import dataclass\n",
         "from dataclasses import dataclass\nimport os\n"),
        ("""            ViTModel.config_class.from_pretrained(
                hf_hub_download(
                    repo_id=self.cfg.pretrained_model_name_or_path,
                    filename="config.json",
                )
            )""",
         """            ViTModel.config_class.from_pretrained(_architecture_config(self.cfg.pretrained_model_name_or_path))"""),
        ("from ...utils import BaseModule\n",
         """from ...utils import BaseModule


def _architecture_config(repository: str) -> str:
    \"\"\"Read the provisioned ViT architecture directory; the worker pod has no egress to the hub.\"\"\"
    local = os.environ.get("TRIPOSR_IMAGE_TOKENIZER_CONFIG")
    return local if local else hf_hub_download(repo_id=repository, filename="config.json")
"""),
    ],
}


def fetch(source: str) -> bytes:
    """Download one pinned file and reject anything that is not the reviewed blob."""
    url = f"https://raw.githubusercontent.com/VAST-AI-Research/TripoSR/{REVISION}/{source}"
    with urllib.request.urlopen(url, timeout=120) as response:
        payload = response.read(2_000_000)
    actual = hashlib.sha1(f"blob {len(payload)}\0".encode() + payload).hexdigest()
    if actual != BLOBS[source]:
        raise ValueError(f"UPSTREAM_SOURCE_CHECKSUM:{source}")
    return payload


def patch(source: str, text: str) -> str:
    """Apply the listed edits, failing closed if an anchor moved under us."""
    for old, new in PATCHES.get(source, []):
        if text.count(old) != 1:
            raise ValueError(f"VENDOR_PATCH_UNAPPLIED:{source}")
        text = text.replace(old, new)
    if source.endswith(".py"):
        import ast

        ast.parse(text)
    return text


def assemble(destination: Path) -> None:
    """Write the patched tree plus attribution, and prove no import still reaches the excluded extras."""
    for source in sorted(BLOBS):
        target = destination / source
        target.parent.mkdir(parents=True, exist_ok=True)
        text = fetch(source).decode("utf-8")
        if source == "LICENSE":
            target.write_text(text, encoding="utf-8")
            continue
        target.write_text(patch(source, text), encoding="utf-8")
    (destination / "NOTICE-triposr").write_text(
        f"VAST-AI-Research/TripoSR {REVISION}, MIT (see LICENSE).\n"
        "Velura changes: march marching cubes on scikit-image, tsr_config replaces omegaconf, "
        "rembg/imageio imports made lazy, DINO-ViT architecture read from the weights volume, "
        "checkpoint parameters renamed for the transformers 5 ViT layout, checkpoint released after "
        "load, tsr/bake_texture.py excluded (needs xatlas plus OpenGL; vertex colours are kept).\n",
        encoding="utf-8",
    )
    for forbidden in ("torchmcubes", "omegaconf"):
        for path in destination.rglob("*.py"):
            if re.search(rf"^\s*(import|from)\s+{forbidden}\b", path.read_text(encoding="utf-8"), re.M):
                raise ValueError(f"VENDOR_FORBIDDEN_IMPORT:{forbidden}")


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser()
    parser.add_argument("--destination", required=True, type=Path)
    assemble(parser.parse_args().destination)
