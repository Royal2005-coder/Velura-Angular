import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AiWorker, AiWorkerResult } from "./ai-types.js";

/**
 * Cluster GPU AI Worker running on local K3s RTX 4060 hardware.
 * Executes visual search CLIP embeddings, rembg background enhancement, and virtual try-on.
 */
export class ClusterAiWorker implements AiWorker {
  private readonly endpoint: string;

  constructor(endpoint?: string) {
    this.endpoint =
      endpoint ||
      process.env.AI_CLUSTER_ENDPOINT ||
      "http://ai-clip.ai.svc:8000";
  }

  /**
   * Worker is active whenever configured for cluster mode or production.
   */
  ready(): boolean {
    const disabled = process.env.AI_DISABLE === "true";
    return !disabled;
  }

  /**
   * Executes inference on the local RTX 4060 GPU service.
   */
  async run(directory: string, signal: AbortSignal): Promise<AiWorkerResult> {
    const rawJob = await readFile(join(directory, "job.json"), "utf8");
    const job = JSON.parse(rawJob) as Record<string, unknown>;
    const task = String(job.task || "");

    if (task === "image_quality") {
      const imgPath = join(
        directory,
        job.person ? "person.image" : "input.image",
      );
      const fileBytes = await readFile(imgPath);
      const form = new FormData();
      form.append("file", new Blob([fileBytes]), "image.png");
      if (job.person_check) {
        form.append("person_check", "true");
      }

      const res = await fetch(`${this.endpoint}/ai/quality`, {
        method: "POST",
        body: form,
        signal,
      });
      if (!res.ok) {
        throw new Error(`AI_QUALITY_FAILED_${res.status}`);
      }
      const data = (await res.json()) as { valid: boolean; [key: string]: unknown };
      return {
        status: data.valid ? "success" : "validation_failed",
        gate: data,
      };
    }

    if (task === "image_embedding") {
      const images = Array.isArray(job.images) ? (job.images as string[]) : [];
      if (images.length > 0) {
        const batchEmbeddings: Array<{
          image: string;
          embedding?: number[];
          error_code?: string;
        }> = [];
        for (const imgName of images) {
          try {
            const fileBytes = await readFile(join(directory, imgName));
            const form = new FormData();
            form.append("file", new Blob([fileBytes]), imgName);
            const res = await fetch(`${this.endpoint}/embed/image`, {
              method: "POST",
              body: form,
              signal,
            });
            if (!res.ok) throw new Error(`HTTP_${res.status}`);
            const data = (await res.json()) as { embedding: number[] };
            batchEmbeddings.push({ image: imgName, embedding: data.embedding });
          } catch {
            batchEmbeddings.push({
              image: imgName,
              error_code: "EMBEDDING_FAILED",
            });
          }
        }
        return {
          status: "success",
          model: "openclip-vit-b32-laion2b",
          dimensions: 512,
          batch_embeddings: batchEmbeddings,
        };
      } else {
        const fileBytes = await readFile(join(directory, "input.image"));
        const form = new FormData();
        form.append("file", new Blob([fileBytes]), "input.png");
        const res = await fetch(`${this.endpoint}/embed/image`, {
          method: "POST",
          body: form,
          signal,
        });
        if (!res.ok) throw new Error(`AI_EMBED_FAILED_${res.status}`);
        const data = (await res.json()) as { embedding: number[] };
        return {
          status: "success",
          model: "openclip-vit-b32-laion2b",
          dimensions: 512,
          embedding: data.embedding,
        };
      }
    }

    if (task === "virtual_try_on") {
      const personBytes = await readFile(join(directory, "person.image"));
      const garmentBytes = await readFile(join(directory, "garment.image"));
      const form = new FormData();
      form.append("person", new Blob([personBytes]), "person.png");
      form.append("garment", new Blob([garmentBytes]), "garment.png");
      form.append("category", String(job.garment_category || "upper_body"));

      const res = await fetch(`${this.endpoint}/ai/try-on`, {
        method: "POST",
        body: form,
        signal,
      });
      if (!res.ok) throw new Error(`AI_TRY_ON_FAILED_${res.status}`);
      const arrayBuf = await res.arrayBuffer();
      await writeFile(join(directory, "result.png"), Buffer.from(arrayBuf));
      return {
        status: "success",
        result_file: "result.png",
      };
    }

    if (task === "product_image_enhance") {
      const inputBytes = await readFile(join(directory, "input.image"));
      const options = (job.options || {}) as Record<string, unknown>;
      const form = new FormData();
      form.append("file", new Blob([inputBytes]), "input.png");
      form.append("background", String(options.background || "white"));
      if (options.brightness) form.append("brightness", "true");
      if (options.sharpness) form.append("sharpness", "true");

      const res = await fetch(`${this.endpoint}/ai/enhance`, {
        method: "POST",
        body: form,
        signal,
      });
      if (!res.ok) throw new Error(`AI_ENHANCE_FAILED_${res.status}`);
      const arrayBuf = await res.arrayBuffer();
      await writeFile(join(directory, "result.png"), Buffer.from(arrayBuf));
      return {
        status: "success",
        result_file: "result.png",
      };
    }

    throw new Error(`UNKNOWN_AI_TASK_${task}`);
  }
}
