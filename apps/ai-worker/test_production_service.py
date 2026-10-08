"""HTTP failure/binding and lease behavior tests; no downloaded weights or GPU claims."""
import asyncio
from io import BytesIO
import json
import threading
import unittest
from unittest.mock import patch
import numpy as np
from PIL import Image
from fastapi.testclient import TestClient
from production_protocol import VERSION
from production_service import BoundedBody, SerialExecutor, WorkerError, create_app

KEY = "test-only-worker-authentication-key-0001"


def unavailable():
    """Represent an actual model-loader failure without importing GPU dependencies."""
    raise RuntimeError("No provisioned GPU/weights in this CPU behavior suite")


def payload():
    """High-resolution sharp center and plain border exercise the measured CPU gate."""
    pixels = np.full((512, 512, 3), 140, dtype=np.uint8)
    pixels[64:-64, 64:-64] = np.random.default_rng(4).integers(100, 180, (384, 384, 3), dtype=np.uint8)
    stream = BytesIO()
    Image.fromarray(pixels).save(stream, format="PNG")
    return stream.getvalue()


def binding(task="image_quality"):
    """Return a structurally valid job binding, never an authenticated business identity."""
    return json.dumps({"schema_version": VERSION, "request_id": "12345678-1234-1234-1234-123456789abc",
                       "task": task, "product_id": "", "variant_id": "", "image_id": "input-1"})


class WorkerServiceTests(unittest.TestCase):
    """Models absent must not fabricate pose, readiness, embedding or try-on success."""

    def test_quality_works_with_failed_loader_but_person_check_fails_closed(self):
        with TestClient(create_app(loader=unavailable, key=KEY)) as client:
            for person, expected in (("false", "success"), ("true", "validation_failed")):
                response = client.post("/ai/quality", headers={"Authorization": "Bearer " + KEY},
                                       data={"binding": binding(), "person_check": person},
                                       files={"file": ("input.png", payload(), "image/png")})
                self.assertEqual(response.status_code, 200)
                self.assertEqual(response.json()["status"], expected)
                self.assertFalse(response.json()["gate"]["pose_checked"])
                self.assertEqual(response.json()["request_id"], json.loads(binding())["request_id"])
                self.assertIn("X-AI-Binding", response.headers)
            readiness = client.get("/ready")
            self.assertEqual(readiness.status_code, 200)
            self.assertTrue(readiness.json()["ready"])
            self.assertFalse(readiness.json()["models_ready"])
            self.assertEqual(readiness.json()["tasks"], {"image_quality": True, "image_embedding": False,
                                                        "product_image_enhance": False, "virtual_try_on": False})
            health = client.get("/health", headers={"Authorization": "Bearer " + KEY})
            self.assertEqual(health.status_code, 503)
            self.assertFalse(health.json()["ready"])
            self.assertFalse(health.json()["models_ready"])
            self.assertTrue(health.json()["tasks"]["image_quality"])
            self.assertEqual(client.get("/live").status_code, 200)
            embedding = client.post("/embed/image", headers={"Authorization": "Bearer " + KEY})
            self.assertEqual(embedding.status_code, 503)
            self.assertEqual(embedding.json()["error_code"], "DEPENDENCIES_UNAVAILABLE")

    def test_cpu_quality_does_not_wait_for_the_gpu_lease(self):
        app = create_app(loader=unavailable, key=KEY)
        with TestClient(app) as client:
            client.portal.call(app.state.executor.slot.acquire)
            try:
                response = client.post("/ai/quality", headers={"Authorization": "Bearer " + KEY},
                                       data={"binding": binding()},
                                       files={"file": ("input.png", payload(), "image/png")})
                self.assertEqual(response.status_code, 200)
                self.assertEqual(response.json()["status"], "success")
            finally:
                client.portal.call(app.state.executor.slot.release)

    def test_missing_auth_or_cpu_dependencies_never_report_routable_readiness(self):
        with TestClient(create_app(loader=unavailable, key="")) as client:
            self.assertEqual(client.get("/ready").status_code, 503)
            self.assertFalse(client.get("/ready").json()["tasks"]["image_quality"])
        with patch("production_service.CpuQuality", side_effect=RuntimeError("CPU dependency failure")):
            with TestClient(create_app(loader=unavailable, key=KEY)) as client:
                self.assertEqual(client.get("/ready").status_code, 503)
                response = client.post("/ai/quality", headers={"Authorization": "Bearer " + KEY},
                                       data={"binding": binding()},
                                       files={"file": ("input.png", payload(), "image/png")})
                self.assertEqual(response.status_code, 503)
                self.assertEqual(response.json()["error_code"], "DEPENDENCIES_UNAVAILABLE")

    def test_authorization_and_binding_mismatch_do_not_process_images(self):
        with TestClient(create_app(loader=unavailable, key=KEY)) as client:
            self.assertEqual(client.post("/ai/quality", content=b"not multipart").status_code, 401)
            response = client.post("/ai/quality", headers={"Authorization": "Bearer " + KEY},
                                   data={"binding": binding("image_embedding")},
                                   files={"file": ("input.png", payload(), "image/png")})
            self.assertEqual(response.status_code, 400)
            self.assertEqual(response.json()["error_code"], "INVALID_INPUT")

    def test_body_authentication_precedes_oversized_upload_buffering(self):
        with patch.dict("os.environ", {"AI_WORKER_KEY": KEY}):
            with TestClient(BoundedBody(create_app(loader=unavailable, key=KEY))) as client:
                unauthorized = client.post("/ai/quality", content=b"x" * 64)
                self.assertEqual(unauthorized.status_code, 401)
                with patch("production_service.MAX_BODY", 32):
                    response = client.post("/ai/quality", headers={"Authorization": "Bearer " + KEY}, content=b"x" * 64)
                self.assertEqual(response.status_code, 413)
                self.assertEqual(response.json()["error_code"], "IMAGE_SIZE")


class SerialExecutorTests(unittest.IsolatedAsyncioTestCase):
    """Disconnected HTTP callers cannot release a still-running GPU operation's lease."""

    async def test_cancellation_holds_slot_until_thread_stops(self):
        executor = SerialExecutor()
        entered = threading.Event()
        finish = threading.Event()

        class Request:
            async def is_disconnected(self):
                return False

        def operation(cancel, deadline):
            entered.set()
            if not finish.wait(2):
                raise RuntimeError("Behavior test failed to release operation")
            return "completed"

        task = asyncio.create_task(executor.run(Request(), operation))
        try:
            self.assertTrue(await asyncio.to_thread(entered.wait, 1))
            task.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await task
            self.assertTrue(executor.slot.locked())
            finish.set()
            await asyncio.gather(*executor.pending)
            self.assertFalse(executor.slot.locked())
        finally:
            finish.set()
            await asyncio.gather(*executor.pending, return_exceptions=True)

    async def test_disconnected_request_returns_finite_failure(self):
        executor = SerialExecutor()
        finish = threading.Event()

        class Request:
            async def is_disconnected(self):
                return True

        def operation(cancel, deadline):
            finish.wait(1)
            return None

        try:
            with self.assertRaises(WorkerError) as caught:
                await executor.run(Request(), operation)
            self.assertEqual(caught.exception.code, "REQUEST_CANCELLED")
        finally:
            finish.set()
            await asyncio.gather(*executor.pending, return_exceptions=True)


if __name__ == "__main__":
    unittest.main()
