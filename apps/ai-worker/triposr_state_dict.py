"""Rename the DINO-ViT block parameters that transformers 5 moved, so the pinned checkpoint still loads.

`stabilityai/TripoSR` ships a 2024 checkpoint whose image-tokenizer keys follow the HuggingFace ViT
layout (`model.encoder.layer.3.attention.attention.query.weight`). transformers 5 rebuilt the same
layers with fused attention names (`model.layers.3.attention.q_proj.weight`) — the arithmetic is
identical, only the parameter path changed. The alternative was pinning transformers 4.44/4.48, which
Trivy scores HIGH with published fixes, so the mapping lives here instead.

Keys that do not match a rule are returned untouched: `load_state_dict` then reports any real
architecture drift loudly rather than silently training against random weights.
"""

import re

BLOCK = re.compile(r"^(?P<prefix>.*\.model\.)encoder\.layer\.(?P<index>\d+)\.(?P<rest>.+)$")
RENAMES = (
    ("attention.attention.query.", "attention.q_proj."),
    ("attention.attention.key.", "attention.k_proj."),
    ("attention.attention.value.", "attention.v_proj."),
    ("attention.output.dense.", "attention.o_proj."),
    ("intermediate.dense.", "mlp.fc1."),
    ("output.dense.", "mlp.fc2."),
)


def remap(state):
    """Map legacy HF-ViT parameter paths onto the transformers 5 layout, leaving everything else alone."""
    renamed = {}
    for key, value in state.items():
        block = BLOCK.match(key)
        if block is None:
            renamed[key] = value
            continue
        rest = block.group("rest")
        for legacy, modern in RENAMES:
            if rest.startswith(legacy):
                rest = modern + rest[len(legacy):]
                break
        renamed[f"{block.group('prefix')}layers.{block.group('index')}.{rest}"] = value
    return renamed
