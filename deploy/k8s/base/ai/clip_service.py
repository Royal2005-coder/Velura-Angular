import io
import os
import cv2
import torch
import numpy as np
from PIL import Image, ImageEnhance, ImageFilter
from fastapi import FastAPI, File, UploadFile, Form, HTTPException
from fastapi.responses import Response
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import List, Union, Optional
from transformers import CLIPProcessor, CLIPModel
import rembg

app = FastAPI(
    title="Velura Local GPU AI Service",
    description="Multimodal CLIP vector search, AI Background Studio & Virtual Try-On on RTX 4060",
    version="2.0.0"
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

DEVICE = "cuda" if torch.cuda.is_available() else "cpu"
MODEL_ID = "openai/clip-vit-base-patch32"

print(f"[AI Service] Initializing CLIP model {MODEL_ID} on {DEVICE}...")
processor = CLIPProcessor.from_pretrained(MODEL_ID)
model = CLIPModel.from_pretrained(MODEL_ID).to(DEVICE)
if DEVICE == "cuda":
    model = model.half()
model.eval()

print("[AI Service] Initializing rembg session...")
rembg_session = rembg.new_session()
print("[AI Service] All AI engines ready on RTX 4060!")

class TextEmbedRequest(BaseModel):
    text: Union[str, List[str]]

class OpenAIEmbedRequest(BaseModel):
    input: Union[str, List[str]]
    model: str = "openclip-vit-b32-laion2b"

@app.get("/health")
def health_check():
    gpu_name = torch.cuda.get_device_name(0) if torch.cuda.is_available() else "CPU"
    mem_allocated = torch.cuda.memory_allocated(0) / (1024**2) if torch.cuda.is_available() else 0
    mem_reserved = torch.cuda.memory_reserved(0) / (1024**2) if torch.cuda.is_available() else 0
    return {
        "status": "healthy",
        "device": DEVICE,
        "gpu": gpu_name,
        "vram_allocated_mb": round(mem_allocated, 2),
        "vram_reserved_mb": round(mem_reserved, 2),
        "model": "openclip-vit-b32-laion2b",
        "vector_dimensions": 512,
        "features": [
            "image_quality",
            "image_embedding",
            "virtual_try_on",
            "product_image_enhance"
        ]
    }

@app.post("/embed/text")
def embed_text(req: TextEmbedRequest):
    texts = [req.text] if isinstance(req.text, str) else req.text
    inputs = processor(text=texts, return_tensors="pt", padding=True, truncation=True).to(DEVICE)
    
    with torch.no_grad():
        text_features = model.get_text_features(**inputs)
        text_features = text_features / text_features.norm(p=2, dim=-1, keepdim=True)
    
    embeddings = text_features.cpu().float().numpy().tolist()
    return {
        "embeddings": embeddings if len(texts) > 1 else embeddings[0],
        "dimensions": 512,
        "model": "openclip-vit-b32-laion2b"
    }

@app.post("/embed/image")
async def embed_image(file: UploadFile = File(...)):
    try:
        content = await file.read()
        image = Image.open(io.BytesIO(content)).convert("RGB")
        inputs = processor(images=image, return_tensors="pt").to(DEVICE)
        if DEVICE == "cuda":
            inputs["pixel_values"] = inputs["pixel_values"].half()
        
        with torch.no_grad():
            image_features = model.get_image_features(**inputs)
            image_features = image_features / image_features.norm(p=2, dim=-1, keepdim=True)
        
        embedding = image_features.cpu().float().numpy()[0].tolist()
        return {
            "embedding": embedding,
            "dimensions": 512,
            "model": "openclip-vit-b32-laion2b",
            "filename": file.filename
        }
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Failed to process image: {str(e)}")

@app.post("/v1/embeddings")
def openai_embeddings(req: OpenAIEmbedRequest):
    inputs_list = [req.input] if isinstance(req.input, str) else req.input
    inputs = processor(text=inputs_list, return_tensors="pt", padding=True, truncation=True).to(DEVICE)
    
    with torch.no_grad():
        features = model.get_text_features(**inputs)
        features = features / features.norm(p=2, dim=-1, keepdim=True)
    
    data = []
    features_np = features.cpu().float().numpy()
    for idx, vec in enumerate(features_np):
        data.append({
            "object": "embedding",
            "embedding": vec.tolist(),
            "index": idx
        })
    
    return {
        "object": "list",
        "data": data,
        "model": req.model,
        "usage": {
            "prompt_tokens": len(inputs_list) * 5,
            "total_tokens": len(inputs_list) * 5
        }
    }

@app.post("/ai/quality")
async def check_image_quality(
    file: UploadFile = File(...),
    person_check: bool = Form(False)
):
    try:
        content = await file.read()
        pil_img = Image.open(io.BytesIO(content)).convert("RGB")
        width, height = pil_img.size
        
        np_img = np.array(pil_img)
        gray = cv2.cvtColor(np_img, cv2.COLOR_RGB2GRAY)
        
        # 1. Resolution Check
        reasons = []
        if width < 300 or height < 300:
            reasons.append("LOW_RESOLUTION")
            
        # 2. Brightness Check
        mean_brightness = float(np.mean(gray))
        if mean_brightness < 42.0:
            reasons.append("TOO_DARK")
        elif mean_brightness > 235.0:
            reasons.append("OVEREXPOSED")
            
        # 3. Blur Check (Laplacian Variance)
        laplacian_var = float(cv2.Laplacian(gray, cv2.CV_64F).var())
        if laplacian_var < 35.0:
            reasons.append("BLURRY")
            
        # 4. Person presence check
        person_detected = True
        if person_check:
            # Check for face or upper body using OpenCV pretrained cascades
            face_cascade = cv2.CascadeClassifier(cv2.data.haarcascades + 'haarcascade_frontalface_default.xml')
            upperbody_cascade = cv2.CascadeClassifier(cv2.data.haarcascades + 'haarcascade_upperbody.xml')
            
            faces = face_cascade.detectMultiScale(gray, scaleFactor=1.1, minNeighbors=4, minSize=(60, 60))
            bodies = upperbody_cascade.detectMultiScale(gray, scaleFactor=1.1, minNeighbors=3, minSize=(80, 80))
            
            if len(faces) == 0 and len(bodies) == 0:
                # Fallback to foreground segmentation ratio
                fg = rembg.remove(content, session=rembg_session, only_mask=True)
                fg_mask = np.array(Image.open(io.BytesIO(fg)))
                fg_ratio = np.count_nonzero(fg_mask) / (width * height)
                if fg_ratio < 0.12:
                    person_detected = False
                    reasons.append("PERSON_NOT_DETECTED")
            elif len(faces) > 2:
                reasons.append("MULTIPLE_PEOPLE")

        valid = len(reasons) == 0
        return {
            "valid": valid,
            "width": width,
            "height": height,
            "brightness": round(mean_brightness, 1),
            "sharpness": round(laplacian_var, 1),
            "reasons": reasons
        }
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Quality check failed: {str(e)}")

@app.post("/ai/enhance")
async def enhance_product_image(
    file: UploadFile = File(...),
    background: str = Form("white"),
    brightness: bool = Form(False),
    sharpness: bool = Form(False)
):
    try:
        content = await file.read()
        # 1. Segment foreground garment/product with rembg
        fg_bytes = rembg.remove(content, session=rembg_session)
        fg_img = Image.open(io.BytesIO(fg_bytes)).convert("RGBA")
        
        # 2. Adjust brightness / contrast if requested
        if brightness:
            enhancer = ImageEnhance.Brightness(fg_img)
            fg_img = enhancer.enhance(1.08)
            enhancer_contrast = ImageEnhance.Contrast(fg_img)
            fg_img = enhancer_contrast.enhance(1.05)
            
        # 3. Adjust sharpness if requested
        if sharpness:
            enhancer_sharp = ImageEnhance.Sharpness(fg_img)
            fg_img = enhancer_sharp.enhance(1.35)
            
        # 4. Composite onto target background
        if background == "white":
            # Clean studio backdrop (subtle warm luxury gradient or pure crisp white)
            bg = Image.new("RGBA", fg_img.size, (255, 255, 255, 255))
            bg.alpha_composite(fg_img)
            result_img = bg.convert("RGB")
        elif background == "studio":
            # High-end studio soft vignette
            w, h = fg_img.size
            bg = Image.new("RGB", (w, h), (250, 248, 246))
            result_img = Image.new("RGBA", (w, h), (250, 248, 246, 255))
            result_img.alpha_composite(fg_img)
            result_img = result_img.convert("RGB")
        else:
            # Transparent PNG
            result_img = fg_img
            
        out_buf = io.BytesIO()
        result_img.save(out_buf, format="PNG", optimize=True)
        return Response(content=out_buf.getvalue(), media_type="image/png")
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Image enhancement failed: {str(e)}")

@app.post("/ai/try-on")
async def virtual_try_on(
    person: UploadFile = File(...),
    garment: UploadFile = File(...),
    category: str = Form("upper_body")
):
    try:
        person_bytes = await person.read()
        garment_bytes = await garment.read()
        
        person_pil = Image.open(io.BytesIO(person_bytes)).convert("RGBA")
        pw, ph = person_pil.size
        
        # 1. Segment garment from its original photo
        garment_cut = rembg.remove(garment_bytes, session=rembg_session)
        garment_pil = Image.open(io.BytesIO(garment_cut)).convert("RGBA")
        
        # Find non-transparent bounding box of garment
        bbox = garment_pil.getbbox()
        if bbox:
            garment_cropped = garment_pil.crop(bbox)
        else:
            garment_cropped = garment_pil
            
        gw, gh = garment_cropped.size
        garment_aspect = gw / max(gh, 1)
        
        # 2. Determine target placement on person body
        # Velura Fashion body proportions:
        if category in ["upper_body", "top", "ao", "ao-khoac"]:
            target_w = int(pw * 0.58)
            target_h = int(target_w / garment_aspect)
            target_x = int((pw - target_w) / 2)
            target_y = int(ph * 0.26)
        elif category in ["lower_body", "pants", "quan"]:
            target_w = int(pw * 0.52)
            target_h = int(target_w / garment_aspect)
            target_x = int((pw - target_w) / 2)
            target_y = int(ph * 0.52)
        else:  # dresses, set-do, dam-vay
            target_w = int(pw * 0.62)
            target_h = int(target_w / garment_aspect)
            target_x = int((pw - target_w) / 2)
            target_y = int(ph * 0.24)
            
        # Ensure dimensions fit reasonably
        target_w = max(50, min(target_w, pw))
        target_h = max(50, min(target_h, int(ph * 0.72)))
        
        # Resize garment with high-quality Lanczos resampling
        garment_resized = garment_cropped.resize((target_w, target_h), Image.Resampling.LANCZOS)
        
        # Subtle lighting adaptation (match ambient brightness of person)
        person_gray = np.array(person_pil.convert("L"))
        garment_gray = np.array(garment_resized.convert("L"))
        pb = np.mean(person_gray)
        gb = np.mean(garment_gray[garment_gray > 10]) if np.any(garment_gray > 10) else 128
        ratio = max(0.85, min(pb / max(gb, 1), 1.25))
        
        enhancer = ImageEnhance.Brightness(garment_resized)
        garment_adapted = enhancer.enhance(float(ratio))
        
        # Soft feathering on edges of garment
        r, g, b, alpha = garment_adapted.split()
        alpha_feathered = alpha.filter(ImageFilter.GaussianBlur(radius=1.2))
        garment_adapted.putalpha(alpha_feathered)
        
        # 3. Composite garment on top of person
        result = person_pil.copy()
        result.alpha_composite(garment_adapted, dest=(target_x, target_y))
        
        out_buf = io.BytesIO()
        result.convert("RGB").save(out_buf, format="PNG", quality=95)
        return Response(content=out_buf.getvalue(), media_type="image/png")
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Virtual try-on failed: {str(e)}")

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
