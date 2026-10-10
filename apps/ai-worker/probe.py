"""Execute through Colab CLI before downloading weights or claiming GPU readiness."""
import json
import platform
import shutil
import subprocess

report = {"python": platform.python_version(), "cuda_available": False}
try:
    import torch
    report.update(torch=torch.__version__, cuda_available=torch.cuda.is_available())
    if torch.cuda.is_available():
        gpu = torch.cuda.get_device_properties(0)
        report.update(gpu=gpu.name, vram_gib=round(gpu.total_memory / 1024 ** 3, 2),
                      bf16_native=torch.cuda.is_bf16_supported(including_emulation=False))
except ImportError:
    report["reason"] = "TORCH_NOT_INSTALLED"
if shutil.which("nvidia-smi"):
    report["nvidia_smi"] = subprocess.run(
        ["nvidia-smi", "--query-gpu=name,memory.total", "--format=csv,noheader"],
        capture_output=True, text=True, timeout=10).stdout.strip()
print(json.dumps(report))
