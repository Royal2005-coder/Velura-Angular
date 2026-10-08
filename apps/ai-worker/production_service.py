"""Private single-GPU inference HTTP service. No image, upload path or request body logs."""
import asyncio
from contextlib import asynccontextmanager
import hmac
import json
import os
from pathlib import Path
import threading
import time
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, Response
from production_protocol import VERSION, TASKS, binding, decode, encoded
from production_quality import CpuQuality

MAX_BODY = 17 * 1024 * 1024
DEADLINE_SECONDS = 180


class WorkerError(Exception):
    """Finite externally safe failure code, independent of internal model exception text."""

    def __init__(self, code: str, status: int = 422):
        self.code, self.status = code, status


class SerialExecutor:
    """Keep the GPU lease until computation really ends, even after HTTP cancellation."""

    def __init__(self):
        self.slot = asyncio.Semaphore(1)
        self.pending = set()

    async def run(self, request, operation):
        try:
            await asyncio.wait_for(self.slot.acquire(), timeout=2)
        except TimeoutError:
            raise WorkerError("WORKER_BUSY", 429)
        cancel = threading.Event()
        deadline = time.monotonic() + DEADLINE_SECONDS

        async def execute():
            try:
                return await asyncio.to_thread(operation, cancel, deadline)
            finally:
                self.slot.release()

        job = asyncio.create_task(execute())
        self.pending.add(job)

        def completed(task):
            self.pending.discard(task)
            if not task.cancelled():
                task.exception()  # Consume detached failures without logging images/paths.

        job.add_done_callback(completed)
        try:
            while not job.done():
                if time.monotonic() >= deadline:
                    raise WorkerError("INFERENCE_DEADLINE", 504)
                if await request.is_disconnected():
                    raise WorkerError("REQUEST_CANCELLED", 499)
                await asyncio.sleep(.1)
            return job.result()
        finally:
            cancel.set()


def create_app(loader=None, key: str | None = None) -> FastAPI:
    """Inject loader only in behavior tests; production always loads all local real models."""
    worker_key = key if key is not None else os.environ.get("AI_WORKER_KEY", "")
    state = {"models": None, "quality": None, "error": "MODELS_LOADING"}
    executor = SerialExecutor()
    quality_executor = SerialExecutor()

    async def load():
        try:
            if len(worker_key) < 32:
                raise ValueError("WORKER_KEY_REQUIRED")
            if loader is None:
                from production_models import ProductionModels
                factory = lambda: ProductionModels(Path(os.environ.get("AI_WEIGHTS_DIR", "/weights")))
            else:
                factory = loader
            state["models"] = await asyncio.to_thread(factory)
            state["error"] = ""
        except Exception:
            state["error"] = "DEPENDENCIES_UNAVAILABLE"

    @asynccontextmanager
    async def lifespan(app):
        try:
            if len(worker_key) < 32:
                raise ValueError("WORKER_KEY_REQUIRED")
            state["quality"] = await asyncio.to_thread(CpuQuality)
        except Exception:
            state["error"] = "DEPENDENCIES_UNAVAILABLE"
        loading = asyncio.create_task(load()) if state["quality"] is not None else None
        yield
        if loading is not None:
            await loading
        pending = executor.pending | quality_executor.pending
        if pending:
            await asyncio.gather(*pending, return_exceptions=True)

    api = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)
    api.state.worker = state
    api.state.executor = executor
    api.state.quality_executor = quality_executor

    @api.get("/live")
    async def live():
        return {"live": True, "schema_version": VERSION}

    @api.get("/ready")
    async def ready():
        cpu_ready = len(worker_key) >= 32 and state["quality"] is not None
        models_ready = state["models"] is not None
        tasks = {task: models_ready or task == "image_quality" and cpu_ready for task in TASKS.values()}
        return JSONResponse({"ready": cpu_ready, "models_ready": models_ready,
                             "schema_version": VERSION, "tasks": tasks},
                            status_code=200 if cpu_ready else 503)

    @api.get("/health")
    async def health(request: Request):
        authorize(request)
        if state["models"] is None:
            cpu_ready = state["quality"] is not None
            return JSONResponse({"ready": False, "models_ready": False, "cpu_ready": cpu_ready,
                                 "schema_version": VERSION, "error_code": state["error"],
                                 "gpu": False, "tasks": {task: task == "image_quality" and cpu_ready for task in TASKS.values()}}, status_code=503)
        return {**state["models"].health, "models_ready": True, "cpu_ready": True}

    def authorize(request):
        supplied = request.headers.get("authorization", "")
        if len(worker_key) < 32 or not hmac.compare_digest(supplied.encode(), ("Bearer " + worker_key).encode()):
            raise WorkerError("WORKER_UNAUTHORIZED", 401)

    @api.exception_handler(WorkerError)
    async def worker_error(request, error):
        return JSONResponse({"schema_version": VERSION, "status": "failed", "error_code": error.code}, status_code=error.status)

    async def inference(request: Request):
        authorize(request)
        task = TASKS[request.url.path]
        if state["models"] is None and task != "image_quality":
            raise WorkerError("DEPENDENCIES_UNAVAILABLE", 503)
        envelope = None
        try:
            async with request.form(max_files=2, max_fields=8, max_part_size=2048) as form:
                envelope = binding(str(form.get("binding", "")), task)
                allowed = {"binding", "person_check", "file"} if task == "image_quality" else {"binding", "file"}
                if task == "virtual_try_on":
                    allowed = {"binding", "person", "garment", "category", "garment_photo_type"}
                elif task == "product_image_enhance":
                    allowed = {"binding", "file", "background", "brightness", "sharpness"}
                if not set(form.keys()) <= allowed or len(form.multi_items()) != len(form):
                    raise ValueError("INVALID_FIELDS")

                async def image(name, maximum):
                    upload = form.get(name)
                    if upload is None or not hasattr(upload, "read"):
                        raise ValueError("IMAGE_REQUIRED")
                    payload = await upload.read(maximum + 1)
                    return await asyncio.to_thread(decode, payload, maximum)

                first = await image("person" if task == "virtual_try_on" else "file", 8 * 1024 * 1024)
                second = await image("garment", 5 * 1024 * 1024) if task == "virtual_try_on" else None
                category = str(form.get("category", ""))
                photo_type = str(form.get("garment_photo_type", ""))
                background = str(form.get("background", "white"))
                if task == "virtual_try_on" and (photo_type != "flat-lay" or category not in {"upper_body", "lower_body", "dresses"}):
                    raise ValueError("UNSUPPORTED_GARMENT_INPUT")
                if background not in {"white", "transparent"}:
                    raise ValueError("INVALID_BACKGROUND")
                flags = {}
                for name in ("person_check", "brightness", "sharpness"):
                    value = str(form.get(name, "false"))
                    if value not in {"true", "false"}:
                        raise ValueError("INVALID_BOOLEAN")
                    flags[name] = value == "true"
        except Exception:
            raise WorkerError("INVALID_INPUT", 400)

        models = state["models"] or state["quality"]
        if models is None:
            raise WorkerError("DEPENDENCIES_UNAVAILABLE", 503)

        def operation(cancel, deadline):
            if cancel.is_set():
                raise WorkerError("REQUEST_CANCELLED", 499)
            if task == "image_quality":
                gate = models.quality(first, flags["person_check"])
                return None, {"status": "success" if gate["valid"] else "validation_failed", "gate": gate}
            if task == "image_embedding":
                return None, {"status": "success", "model": "openclip-vit-b32-laion2b", "dimensions": 512,
                              "embedding": models.embedding(first)}
            if task == "virtual_try_on":
                gate = models.quality(first, True)
                if not gate["valid"]:
                    return None, {"status": "validation_failed", "gate": gate}
                output = models.vton.infer(first, second, category, cancel, deadline)
                gate = models.quality(output, True)
                model = "fashn-vton-1.5-maskless-flatlay"
            else:
                output, gate = models.enhance(first, background, flags["brightness"], flags["sharpness"])
                model = "u2net-apache2"
            if not gate["valid"]:
                return None, {"status": "validation_failed", "gate": gate}
            from production_models import png
            return png(output), {"status": "success", "model": model, "gate": gate}

        headers = {"X-AI-Binding": encoded(envelope), "Cache-Control": "no-store"}
        try:
            runner = quality_executor if task == "image_quality" else executor
            payload, result = await runner.run(request, operation)
            if payload is None:
                return JSONResponse({**envelope, **result}, headers=headers)
            headers["X-AI-Result"] = encoded(result)
            return Response(payload, media_type="image/png", headers=headers)
        except WorkerError as error:
            return JSONResponse({**envelope, "status": "failed", "error_code": error.code}, status_code=error.status, headers=headers)
        except Exception:
            return JSONResponse({**envelope, "status": "failed", "error_code": "INFERENCE_FAILED"}, status_code=500, headers=headers)

    for path in TASKS:
        api.add_api_route(path, inference, methods=["POST"])
    return api


class BoundedBody:
    """Authenticate before reading, reject oversized/chunked bodies before multipart allocation."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or scope["path"] not in TASKS:
            return await self.app(scope, receive, send)
        headers = dict(scope.get("headers", []))
        key = os.environ.get("AI_WORKER_KEY", "")
        if len(key) < 32 or not hmac.compare_digest(headers.get(b"authorization", b""), ("Bearer " + key).encode()):
            return await JSONResponse({"status": "failed", "error_code": "WORKER_UNAUTHORIZED", "schema_version": VERSION}, status_code=401)(scope, receive, send)
        total = 0
        messages = []
        start = time.monotonic()
        while True:
            try:
                message = await asyncio.wait_for(receive(), timeout=max(.01, 30 - (time.monotonic() - start)))
            except TimeoutError:
                return await JSONResponse({"status": "failed", "error_code": "UPLOAD_DEADLINE"}, status_code=408)(scope, receive, send)
            if message["type"] == "http.disconnect":
                return
            total += len(message.get("body", b""))
            if total > MAX_BODY:
                return await JSONResponse({"status": "failed", "error_code": "IMAGE_SIZE"}, status_code=413)(scope, receive, send)
            messages.append(message)
            if not message.get("more_body", False):
                break
        index = 0

        async def bounded_receive():
            nonlocal index
            if index < len(messages):
                message = messages[index]
                index += 1
                return message
            return await receive()

        return await self.app(scope, bounded_receive, send)


app = BoundedBody(create_app())
