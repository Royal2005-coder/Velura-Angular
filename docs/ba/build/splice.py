# -*- coding: utf-8 -*-
from pathlib import Path
p = Path(__file__).with_name("ba_models.py")
lines = p.read_text(encoding="utf-8").split("\n")
start = next(i for i, l in enumerate(lines) if l.startswith("def dia_image_ai"))
end = next(i for i in range(start, len(lines)) if lines[i] == "    return d")
new = Path(__file__).with_name("new_anh.txt").read_text(encoding="utf-8").rstrip("\n").split("\n")
lines[start:end + 1] = new
p.write_text("\n".join(lines), encoding="utf-8")
print("spliced", start, end)
