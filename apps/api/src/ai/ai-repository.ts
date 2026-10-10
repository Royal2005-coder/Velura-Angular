import { mkdir, readFile, writeFile, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { AiAsset, AiJob } from "./ai-types.js";

/** Single-writer private ledger on a persistent volume; off-site backup is required and this is not HA. */
export class LocalAiRepository {
  readonly root: string;
  private writes = new Map<string, Promise<unknown>>();
  constructor(root: string) {
    this.root = resolve(root);
  }
  /** Persist an asset under its generated UUID, never under a client filename. */
  async saveAsset(asset: AiAsset, bytes: Buffer): Promise<void> {
    await mkdir(join(this.root, "assets"), { recursive: true, mode: 0o700 });
    await writeFile(asset.path, bytes, { mode: 0o600 });
    await writeFile(
      join(this.root, "assets", `${asset.id}.json`),
      JSON.stringify(asset),
      { mode: 0o600 },
    );
  }
  /** Read trusted ledger metadata only; callers must enforce ownership and TTL. */
  async asset(id: string): Promise<AiAsset | null> {
    try {
      return JSON.parse(
        await readFile(join(this.root, "assets", `${id}.json`), "utf8"),
      ) as AiAsset;
    } catch {
      return null;
    }
  }
  /** Delete only a generated asset identity; owner authorization belongs to the service. */
  async deleteAsset(id: string): Promise<void> {
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(id)) throw new Error("INVALID_ASSET_ID");
    await Promise.all([
      rm(join(this.root, "assets", `${id}.image`), { force: true }),
      rm(join(this.root, "assets", `${id}.json`), { force: true }),
    ]);
  }
  /** Store job state atomically to avoid partial JSON during polling or restart. */
  async saveJob(job: AiJob): Promise<void> {
    const snapshot = JSON.parse(JSON.stringify(job)) as AiJob;
    const pending = (this.writes.get(job.id) || Promise.resolve()).then(() =>
      this.writeJob(snapshot),
    );
    this.writes.set(
      job.id,
      pending.catch(() => undefined),
    );
    await pending;
  }
  private async writeJob(job: AiJob): Promise<void> {
    await mkdir(job.directory, { recursive: true, mode: 0o700 });
    const { rename } = await import("node:fs/promises");
    const temporary = join(job.directory, `${randomUUID()}.tmp`);
    await writeFile(temporary, JSON.stringify(job), { mode: 0o600 });
    for (let attempt = 0; ; attempt++) {
      try {
        await rename(temporary, join(job.directory, "ledger.json"));
        break;
      } catch (error) {
        const code =
          typeof error === "object" && error && "code" in error
            ? String(error.code)
            : "";
        if (attempt >= 8 || !["EPERM", "EACCES", "EBUSY"].includes(code))
          throw error;
        await new Promise((resolve) => setTimeout(resolve, 10 * (attempt + 1)));
      }
    }
  }
  /** Compare-and-set serialized job transition keeps late inference from overwriting cancellation. */
  async transition(
    id: string,
    allowed: AiJob["status"][],
    patch: Partial<AiJob>,
  ): Promise<AiJob | null> {
    const pending = (this.writes.get(id) || Promise.resolve()).then(
      async () => {
        const job = await this.job(id);
        if (!job || !allowed.includes(job.status)) return null;
        const updated = { ...job, ...patch };
        await this.writeJob(updated);
        return updated;
      },
    );
    this.writes.set(
      id,
      pending.catch(() => undefined),
    );
    return pending;
  }
  /** Read a UUID-selected private job without allowing arbitrary path selection. */
  async job(id: string): Promise<AiJob | null> {
    try {
      return JSON.parse(
        await readFile(join(this.root, "jobs", id, "ledger.json"), "utf8"),
      ) as AiJob;
    } catch {
      return null;
    }
  }
  /** Enumerate private local ledger for queue recovery and expiry, not public browsing. */
  async jobs(): Promise<AiJob[]> {
    const { readdir } = await import("node:fs/promises");
    const names = await readdir(join(this.root, "jobs")).catch(
      () => [] as string[],
    );
    const rows = await Promise.all(
      names
        .filter((name) => /^[a-f0-9-]{36}$/.test(name))
        .map((name) => this.job(name)),
    );
    return rows.filter((row): row is AiJob => row !== null);
  }
  /** Expired jobs and their copies are removed; the caller periodically invokes maintenance. */
  async purge(now = Date.now()): Promise<void> {
    for (const job of await this.jobs())
      if (Date.parse(job.expires_at) <= now)
        await rm(job.directory, { recursive: true, force: true });
    const { readdir } = await import("node:fs/promises");
    for (const filename of await readdir(join(this.root, "assets")).catch(
      () => [] as string[],
    )) {
      if (!filename.endsWith(".json")) continue;
      const asset = await this.asset(filename.slice(0, -5));
      if (asset && Date.parse(asset.expires_at) <= now) {
        await rm(asset.path, { force: true });
        await rm(join(this.root, "assets", filename), { force: true });
      }
    }
  }
  /** Bound result bytes before reading an image into the HTTP process. */
  async result(job: AiJob): Promise<Buffer> {
    const path = join(job.directory, "result.png");
    if ((await stat(path)).size > 12 * 1024 * 1024)
      throw new Error("RESULT_TOO_LARGE");
    const bytes = await readFile(path);
    if (
      !bytes
        .subarray(0, 8)
        .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    )
      throw new Error("INVALID_IMAGE_RESULT");
    return bytes;
  }
}
