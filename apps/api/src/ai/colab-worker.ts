import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import {
  readFile,
  stat,
  writeFile,
  open,
  unlink,
  mkdir,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import type { AiWorker, AiWorkerResult } from "./ai-types.js";

const execute = promisify(execFile);
/** Fixed executable seam supports transport tests without logging or consuming GPU credentials. */
export type AiCommandExecutor = (
  file: string,
  args: string[],
  options: {
    signal?: AbortSignal;
    timeout: number;
    maxBuffer: number;
    windowsHide: boolean;
  },
) => Promise<unknown>;
/** WSL Colab CLI adapter: fixed commands and validated paths, never a shell/user callback. */
export class ColabAiWorker implements AiWorker {
  private blocked = false;
  private leased = false;
  constructor(
    private readonly command: AiCommandExecutor = (file, args, options) =>
      execute(file, args, options),
  ) {}
  /** Readiness is explicit; GPU provisioning and authentication stay in the operator's terminal. */
  ready(): boolean {
    const externalLease =
      !this.leased &&
      existsSync(
        join(
          resolve(process.env.AI_PRIVATE_ROOT || "scratch/ai-private"),
          "colab-runtime.lock",
        ),
      );
    return (
      !externalLease &&
      !this.blocked &&
      process.env.NODE_ENV !== "production" &&
      process.env.AI_ENGINE_MODE === "colab-local" &&
      process.env.AI_COLAB_READY === "true" &&
      /^[a-zA-Z0-9_-]{1,64}$/.test(process.env.AI_COLAB_SESSION || "")
    );
  }
  /** Upload private inputs, invoke one worker and download bounded outputs without logging tokens. */
  async run(directory: string, signal: AbortSignal): Promise<AiWorkerResult> {
    if (!this.ready()) throw new Error("AI_ENGINE_UNAVAILABLE");
    const session = process.env.AI_COLAB_SESSION!;
    const cli = process.env.AI_COLAB_CLI || "/home/gia/.local/bin/colab";
    if (!/^\/home\/[a-zA-Z0-9_-]+\/\.local\/bin\/colab$/.test(cli))
      throw new Error("INVALID_COLAB_CLI_PATH");
    const remoteRoot = process.env.AI_COLAB_ROOT || "/content/velura-ai";
    if (!/^\/content\/[a-zA-Z0-9_-]+$/.test(remoteRoot))
      throw new Error("INVALID_RUNTIME_PATH");
    const id = directory.split(/[\\/]/).pop()!;
    if (
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(
        id,
      )
    )
      throw new Error("INVALID_JOB_PATH");
    const linux = directory
      .replace(
        /^([A-Za-z]):[\\/]/,
        (_, drive: string) => `/mnt/${drive.toLowerCase()}/`,
      )
      .replaceAll("\\", "/");
    const options = {
      signal,
      timeout: 20 * 60_000,
      maxBuffer: 256 * 1024,
      windowsHide: true,
    };
    const lockRoot = resolve(
      process.env.AI_PRIVATE_ROOT || "scratch/ai-private",
    );
    await mkdir(lockRoot, { recursive: true, mode: 0o700 });
    const lock = join(lockRoot, "colab-runtime.lock");
    let lease;
    try {
      lease = await open(lock, "wx", 0o600);
    } catch {
      this.blocked = true;
      throw new Error("AI_RUNTIME_BUSY_OR_RECOVERY_REQUIRED");
    }
    this.leased = true;
    await lease.writeFile(
      JSON.stringify({
        pid: process.pid,
        session,
        job_id: id,
        created_at: new Date().toISOString(),
      }),
    );
    await lease.close();
    const remote = `${remoteRoot}/jobs/${id}`;
    const input = JSON.parse(
      await readFile(join(directory, "job.json"), "utf8"),
    ) as Record<string, unknown>;
    const script = `import subprocess\nsubprocess.run([${JSON.stringify(`${remoteRoot}/.venv/bin/python`)},${JSON.stringify(`${remoteRoot}/infer.py`)},${JSON.stringify(remote)}],check=True)\n`;
    await writeFile(join(directory, "run.py"), script, { mode: 0o600 });
    await writeFile(
      join(directory, "prepare.py"),
      `from pathlib import Path\np=Path(${JSON.stringify(remote)})\np.mkdir(parents=True,exist_ok=True)\np.chmod(0o700)\n`,
      { mode: 0o600 },
    );
    await writeFile(
      join(directory, "cleanup.py"),
      `import shutil\nshutil.rmtree(${JSON.stringify(remote)},ignore_errors=True)\n`,
      { mode: 0o600 },
    );
    let transportStage = "prepare";
    try {
      await this.command(
        "wsl.exe",
        [
          "-d",
          "Ubuntu",
          "--",
          cli,
          "exec",
          "-s",
          session,
          "-f",
          `${linux}/prepare.py`,
          "--timeout",
          "30",
        ],
        options,
      );
      const images = Array.isArray(input.images) ? input.images : [];
      if (images.length > 16) throw new Error("INVALID_IMAGE_BATCH");
      const files = [
        "job.json",
        ...["image", "person", "garment"]
          .map((key) => input[key])
          .filter((name): name is string => typeof name === "string"),
        ...images,
      ];
      for (const file of files) {
        transportStage = "upload";
        if (
          typeof file !== "string" ||
          (![
            "job.json",
            "input.image",
            "person.image",
            "garment.image",
          ].includes(file) &&
            !/^catalog-(?:[0-9]|1[0-5])\.image$/.test(file))
        )
          throw new Error("INVALID_INPUT_PATH");
        await this.command(
          "wsl.exe",
          [
            "-d",
            "Ubuntu",
            "--",
            cli,
            "upload",
            "-s",
            session,
            `${linux}/${file}`,
            `${remote}/${file}`,
          ],
          options,
        );
      }
      transportStage = "inference";
      await this.command(
        "wsl.exe",
        [
          "-d",
          "Ubuntu",
          "--",
          cli,
          "exec",
          "-s",
          session,
          "-f",
          `${linux}/run.py`,
          "--timeout",
          "1100",
        ],
        options,
      );
      transportStage = "download_result";
      await this.command(
        "wsl.exe",
        [
          "-d",
          "Ubuntu",
          "--",
          cli,
          "download",
          "-s",
          session,
          `${remoteRoot}/jobs/${id}/result.json`,
          `${linux}/result.json`,
        ],
        options,
      );
      // A verified 16-image batch contains up to 8,192 finite CLIP floats plus bounded metadata.
      const resultLimit = images.length ? 512 * 1024 : 128 * 1024;
      if ((await stat(join(directory, "result.json"))).size > resultLimit)
        throw new Error("RESULT_TOO_LARGE");
      const raw: unknown = JSON.parse(
        await readFile(join(directory, "result.json"), "utf8"),
      );
      if (
        !raw ||
        typeof raw !== "object" ||
        !("status" in raw) ||
        !["success", "validation_failed", "failed"].includes(String(raw.status))
      )
        throw new Error("INVALID_WORKER_RESULT");
      const result = raw as AiWorkerResult;
      if (
        result.result_file !== undefined &&
        result.result_file !== "result.png"
      )
        throw new Error("INVALID_RESULT_PATH");
      if (result.result_file)
        await this.command(
          "wsl.exe",
          [
            "-d",
            "Ubuntu",
            "--",
            cli,
            "download",
            "-s",
            session,
            `${remoteRoot}/jobs/${id}/result.png`,
            `${linux}/result.png`,
          ],
          options,
        );
      return result;
    } catch (error) {
      // Killing the local CLI does not prove the remote GPU process stopped. Re-provision/restart explicitly.
      this.blocked = true;
      const code =
        error && typeof error === "object" && "code" in error
          ? error.code
          : null;
      // Preserve a bounded operational diagnosis, never CLI stdout, command lines or uploaded content.
      await writeFile(
        join(directory, "transport-failure.json"),
        JSON.stringify({
          stage: transportStage,
          code:
            typeof code === "number"
              ? code
              : typeof code === "string" && /^[A-Z0-9_]{1,64}$/.test(code)
                ? code
                : "TRANSPORT_ERROR",
          aborted: signal.aborted,
        }),
        { mode: 0o600 },
      ).catch(() => undefined);
      throw error;
    } finally {
      // Cancellation aborts inference transport; cleanup uses an independent bounded control request.
      await this.command(
        "wsl.exe",
        [
          "-d",
          "Ubuntu",
          "--",
          cli,
          "exec",
          "-s",
          session,
          "-f",
          `${linux}/cleanup.py`,
          "--timeout",
          "30",
        ],
        { timeout: 45_000, maxBuffer: 64 * 1024, windowsHide: true },
      ).catch(async () => {
        this.blocked = true;
        await writeFile(
          join(directory, "remote-cleanup-pending.json"),
          JSON.stringify({ session, remote }),
          { mode: 0o600 },
        );
      });
      if (!this.blocked) await unlink(lock);
      this.leased = false;
    }
  }
}
