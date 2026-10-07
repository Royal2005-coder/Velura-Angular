import requests

res = requests.get("http://127.0.0.1:8000/health").json()
print("Health:", res)

text_res = requests.post("http://127.0.0.1:8000/embed/text", json={"text": "ao so mi trang lua"}).json()
print("Dimensions:", text_res.get("dimensions"))
vec = text_res.get("embeddings")
print("Vector length:", len(vec) if isinstance(vec, list) else "not list")
print("First 5 vector values:", vec[:5] if isinstance(vec, list) else None)
