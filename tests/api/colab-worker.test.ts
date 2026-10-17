import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { ColabAiWorker } from "../../apps/api/src/ai/colab-worker.js";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "colab-transport-")),
    directory = join(root, randomUUID());
  await mkdir(directory);
  process.env.NODE_ENV = "test";
  process.env.AI_ENGINE_MODE = "colab-local";
  process.env.AI_COLAB_READY = "true";
  process.env.AI_COLAB_SESSION = "velura-ai";
  process.env.AI_COLAB_ROOT = "/content/velura-ai";
  process.env.AI_PRIVATE_ROOT = root;
  process.env.AI_COLAB_CLI = "/home/gia/.local/bin/colab";
  await writeFile(
    join(directory, "job.json"),
    JSON.stringify({ task: "image_quality", image: "input.image" }),
  );
  await writeFile(
    join(directory, "input.image"),
    Buffer.from("private test bytes"),
  );
  await writeFile(
    join(directory, "result.json"),
    JSON.stringify({ status: "success", gate: { valid: true } }),
  );
  return {
    root,
    directory,
    async close() {
      await rm(root, { recursive: true, force: true });
    },
  };
}
test("Colab transport uses absolute executable and fixed Python scripts; successful cleanup releases GPU lease", async () => {
  const item = await fixture();
  const calls: string[][] = [];
  try {
    const worker = new ColabAiWorker(async (file, args) => {
      assert.equal(file, "wsl.exe");
      assert.equal(args[3], "/home/gia/.local/bin/colab");
      calls.push(args);
    });
    assert.equal(worker.ready(), true);
    const result = await worker.run(
      item.directory,
      new AbortController().signal,
    );
    assert.equal(result.status, "success");
    assert(
      calls.some(
        (args) => args[4] === "upload" && args.at(-1)?.endsWith("/input.image"),
      ),
    );
    assert(
      calls.some(
        (args) => args[4] === "exec" && args.some((a) => a.endsWith("/run.py")),
      ),
    );
    assert(calls.at(-1)?.some((arg) => arg.endsWith("/cleanup.py")));
    assert.equal(existsSync(join(item.root, "colab-runtime.lock")), false);
    const script = await readFile(join(item.directory, "run.py"), "utf8");
    assert.match(script, /subprocess.run\(\[/);
    assert.doesNotMatch(script, /shell=True/);
  } finally {
    await item.close();
  }
});
test("Remote transport failure keeps readiness disabled and persistent lease for explicit recovery", async () => {
  const item = await fixture();
  let calls = 0;
  try {
    const worker = new ColabAiWorker(async () => {
      calls++;
      if (calls === 2) throw new Error("Transport lost");
    });
    await assert.rejects(
      () => worker.run(item.directory, new AbortController().signal),
      /Transport lost/,
    );
    assert.equal(worker.ready(), false);
    assert.equal(existsSync(join(item.root, "colab-runtime.lock")), true);
    assert.equal(new ColabAiWorker(async () => undefined).ready(), false);
    const diagnosis = JSON.parse(
      await readFile(join(item.directory, "transport-failure.json"), "utf8"),
    );
    assert.deepEqual(diagnosis, {
      stage: "upload",
      code: "TRANSPORT_ERROR",
      aborted: false,
    });
    assert.doesNotMatch(
      JSON.stringify(diagnosis),
      /Transport lost|private test bytes/,
    );
    const before = calls;
    await assert.rejects(
      () => worker.run(item.directory, new AbortController().signal),
      /AI_ENGINE_UNAVAILABLE/,
    );
    assert.equal(calls, before);
  } finally {
    await item.close();
  }
});
test("Invalid remote roots and arbitrary CLI paths are rejected before any command executes", async () => {
  const item = await fixture();
  let calls = 0;
  try {
    const worker = new ColabAiWorker(async () => {
      calls++;
    });
    process.env.AI_COLAB_ROOT = "/content/../private";
    await assert.rejects(
      () => worker.run(item.directory, new AbortController().signal),
      /INVALID_RUNTIME_PATH/,
    );
    process.env.AI_COLAB_ROOT = "/content/velura-ai";
    process.env.AI_COLAB_CLI = "/bin/bash";
    await assert.rejects(
      () => worker.run(item.directory, new AbortController().signal),
      /INVALID_COLAB_CLI_PATH/,
    );
    assert.equal(calls, 0);
  } finally {
    await item.close();
  }
});
test("Transport accepts bounded CLIP batch result above single-image limit and rejects results above batch cap", async () => {
  const item = await fixture();
  try {
    const images = Array.from({ length: 16 }, (_, i) => `catalog-${i}.image`);
    await writeFile(
      join(item.directory, "job.json"),
      JSON.stringify({ task: "image_embedding", images }),
    );
    const batch = {
      status: "success",
      model: "openclip-vit-b32-laion2b",
      dimensions: 512,
      batch_embeddings: images.map((image) => ({
        image,
        embedding: Array(512).fill(0.12345678901234567),
      })),
    };
    const json = JSON.stringify(batch);
    assert(Buffer.byteLength(json) > 128 * 1024);
    assert(Buffer.byteLength(json) < 512 * 1024);
    await writeFile(join(item.directory, "result.json"), json);
    const worker = new ColabAiWorker(async () => undefined);
    assert.equal(
      (await worker.run(item.directory, new AbortController().signal)).status,
      "success",
    );
    await writeFile(
      join(item.directory, "result.json"),
      " ".repeat(512 * 1024 + 1),
    );
    await assert.rejects(
      () => worker.run(item.directory, new AbortController().signal),
      /RESULT_TOO_LARGE/,
    );
  } finally {
    await item.close();
  }
});
