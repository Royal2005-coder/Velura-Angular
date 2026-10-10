"""Explicit offline-weight provisioning; worker startup only verifies and never downloads."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import urllib.request

MANIFEST = Path(__file__).with_name("weights-manifest.json")


def manifest() -> dict:
    """Load the reviewed versioned manifest, rejecting unspecified revisions/licenses."""
    data = json.loads(MANIFEST.read_text(encoding="utf-8"))
    for item in data["artifacts"]:
        if item["license"] not in {"Apache-2.0", "MIT"} or not item.get("license_evidence"):
            raise ValueError("WEIGHT_LICENSE_UNVERIFIED")
        if "repo" in item and not re.fullmatch(r"[0-9a-f]{40}", item["revision"]):
            raise ValueError("WEIGHT_REVISION_UNPINNED")
    return data


def verify_file(path: Path, item: dict) -> str:
    """Verify exact bytes, source checksum and emit a SHA256 inventory receipt."""
    if not path.is_file() or path.stat().st_size != item["size"]:
        raise ValueError("WEIGHTS_MISSING_OR_SIZE")
    sha = hashlib.sha256()
    if "md5" in item:
        try:
            legacy = hashlib.md5(usedforsecurity=False)
        except TypeError:
            legacy = hashlib.md5()
    else:
        legacy = None
    with path.open("rb") as stream:
        while chunk := stream.read(1024 * 1024):
            sha.update(chunk)
            if legacy is not None:
                legacy.update(chunk)
    digest = sha.hexdigest()
    if "sha256" in item and digest != item["sha256"]:
        raise ValueError("WEIGHTS_CHECKSUM")
    if legacy is not None and legacy.hexdigest() != item["md5"]:
        raise ValueError("WEIGHTS_CHECKSUM")
    return digest


def verify_weights(root: Path) -> dict:
    """Fail closed if any locally provisioned dependency differs from the reviewed manifest."""
    data = manifest()
    receipt_path = root / "verified-inventory.json"
    if not receipt_path.is_file():
        raise ValueError("WEIGHT_RECEIPT_MISSING")
    receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
    if receipt.get("manifest_sha256") != hashlib.sha256(MANIFEST.read_bytes()).hexdigest():
        raise ValueError("WEIGHT_RECEIPT_VERSION")
    for item in data["artifacts"]:
        digest = verify_file(root / item["path"], item)
        if receipt.get("sha256", {}).get(item["path"]) != digest:
            raise ValueError("WEIGHT_RECEIPT_CHECKSUM")
    return data


def download(root: Path, accepted_version: str) -> None:
    """Download reviewed revisions only after explicit operator license acceptance."""
    data = manifest()
    if accepted_version != data["version"]:
        raise ValueError("EXPLICIT_LICENSE_ACCEPTANCE_REQUIRED")
    receipt = {"manifest_sha256": hashlib.sha256(MANIFEST.read_bytes()).hexdigest(), "sha256": {}}
    for item in data["artifacts"]:
        target = root / item["path"]
        target.parent.mkdir(parents=True, exist_ok=True)
        if not target.exists():
            url = item.get("url") or f'https://huggingface.co/{item["repo"]}/resolve/{item["revision"]}/{item["file"]}'
            temporary = target.with_suffix(target.suffix + ".partial")
            try:
                with urllib.request.urlopen(url, timeout=120) as response, temporary.open("wb") as output:
                    count = 0
                    while chunk := response.read(1024 * 1024):
                        count += len(chunk)
                        if count > item["size"]:
                            raise ValueError("WEIGHT_DOWNLOAD_SIZE")
                        output.write(chunk)
                verify_file(temporary, item)
                temporary.replace(target)
            finally:
                temporary.unlink(missing_ok=True)
        receipt["sha256"][item["path"]] = verify_file(target, item)
    receipt_path = root / "verified-inventory.json"
    receipt_path.write_text(json.dumps(receipt, indent=2), encoding="utf-8")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--weights-dir", required=True, type=Path)
    parser.add_argument("--accept-license-manifest", required=True)
    args = parser.parse_args()
    download(args.weights_dir, args.accept_license_manifest)
