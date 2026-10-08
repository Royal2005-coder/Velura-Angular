"""Assemble only Apache-2.0 FASHN modules; never install its parser-bearing distribution."""
import hashlib
from pathlib import Path
import urllib.request

REVISION = "7c0f10af3f91ad4048fe9729c470a13ef905d25a"
# Git blob IDs from the pinned upstream tree. Excludes pipeline, agnostic, masks and both eager initializers.
BLOBS = {
    "LICENSE": "2a35f0c24ccd9ce4e4031ab1ff835b4e7dd5b904",
    "src/fashn_vton/tryon_mmdit.py": "fab0ac39cd06ba547f3408e062ca9c5ee10b67ef",
    "src/fashn_vton/dwpose/__init__.py": "4566b7b2e130158e5aab505394ba628643e1d876",
    "src/fashn_vton/dwpose/dwpose.py": "1e2c21a2249910c600099e50ce0a737aef94869d",
    "src/fashn_vton/dwpose/onnxdet.py": "e2b0abd330b868e682c8d10e5609465f56ed7ec8",
    "src/fashn_vton/dwpose/onnxpose.py": "a5c1ff245df8cf62ef31a8a892f6b07877189754",
    "src/fashn_vton/dwpose/utils.py": "31f3b2b2df1371d942bc7a51f39e9d0da449465c",
    "src/fashn_vton/dwpose/wholebody.py": "0331a538a5683001d1f5f652939dd41a93cb568d",
    "src/fashn_vton/preprocessing/transforms.py": "b03aae3fa4737c6d463d50c1cd5799f54435c8d7",
    "src/fashn_vton/utils/__init__.py": "2757c6693546e498c9c79d57e6bb2e4e78b2fd92",
    "src/fashn_vton/utils/checkpoint.py": "7155575d96debb10c9f7725a9d5f277cc2ae80d7",
    "src/fashn_vton/utils/common.py": "06f37164f33049debec40672519594026da29416",
    "src/fashn_vton/utils/keypoints.py": "0cc6d6913273a97f580e0d7eaf1217ab36b75218",
    "src/fashn_vton/utils/logger.py": "bb6418d38b802f119f0693b3683dcd850974c291",
    "src/fashn_vton/utils/sampling.py": "b42dee0ae298ee7e3e86b2d171c00576c8752a30",
    "src/fashn_vton/utils/tensor.py": "046aab422edfe4a86edbf022e87453ffbc75ba36",
}


def assemble(destination: Path) -> None:
    """Fetch immutable, blob-verified source and retain upstream attribution."""
    for source, digest in BLOBS.items():
        url = f"https://raw.githubusercontent.com/fashn-AI/fashn-vton-1.5/{REVISION}/{source}"
        with urllib.request.urlopen(url, timeout=60) as response:
            payload = response.read(1_000_000)
        actual = hashlib.sha1(f"blob {len(payload)}\0".encode() + payload).hexdigest()
        if actual != digest:
            raise ValueError("UPSTREAM_SOURCE_CHECKSUM")
        if source.endswith(".py") and b"fashn_human_parser" in payload:
            raise ValueError("FORBIDDEN_PARSER_IMPORT")
        target = destination / source.removeprefix("src/")
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(payload)
    notice = f'"""Velura maskless subset of FASHN VTON {REVISION}; Apache-2.0. Eager parser pipeline excluded."""\n'
    for package in ("fashn_vton", "fashn_vton/preprocessing"):
        (destination / package / "__init__.py").write_text(notice, encoding="utf-8")
    (destination / "NOTICE").write_text(
        f"FASHN AI fashn-vton-1.5 {REVISION}, Apache-2.0.\n"
        "DWPose by Zhendong Yang, Ailing Zeng, Chun Yuan and Yu Li (IDEA-Research), Apache-2.0.\n"
        "TryOnModel contains Apache-2.0 FLUX.1 components by Black Forest Labs.\n"
        "Velura changes: allowlisted package; parser-bearing modules excluded; own maskless flat-lay pipeline.\n",
        encoding="utf-8",
    )


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument("--destination", required=True, type=Path)
    assemble(parser.parse_args().destination)
