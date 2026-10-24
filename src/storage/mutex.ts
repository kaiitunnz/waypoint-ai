import { randomUUID, createHash } from "node:crypto";
import { mkdir, writeFile, link, unlink, readFile, rmdir } from "node:fs/promises";
import { join } from "node:path";
import { isRecord } from "../domain/connections";

const queues = new Map<string, Promise<unknown>>();
export class ServerMutex {
  constructor(
    private readonly directory: string,
    private readonly waitMs = 2500,
  ) {}
  async run<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const key = join(this.directory, createHash("sha256").update(id).digest("hex"));
    const previous = queues.get(key) ?? Promise.resolve();
    const run = previous.then(() => this.exclusive(key, operation));
    const settled = run.catch(() => undefined);
    queues.set(key, settled);
    try {
      return await run;
    } finally {
      if (queues.get(key) === settled) queues.delete(key);
    }
  }
  private async exclusive<T>(path: string, operation: () => Promise<T>): Promise<T> {
    await mkdir(this.directory, { recursive: true });
    const owner = `${path}.${process.pid}.${randomUUID()}`;
    const nonce = randomUUID();
    await writeFile(owner, JSON.stringify({ pid: process.pid, nonce }), { flag: "wx", mode: 0o600 });
    let acquired = false;
    const started = Date.now();
    try {
      while (!acquired) {
        try {
          await link(owner, path);
          acquired = true;
        } catch (error) {
          if (!isRecord(error) || error.code !== "EEXIST") throw error;
          await this.reclaim(path);
          if (Date.now() - started >= this.waitMs)
            throw new Error("Another Quick Chat operation is still active for this server. Retry when it finishes.");
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
      }
      return await operation();
    } finally {
      if (acquired) {
        const current: unknown = JSON.parse(await readFile(path, "utf8"));
        if (isRecord(current) && current.nonce === nonce) await unlink(path);
      }
      await unlink(owner).catch(() => undefined);
    }
  }
  private async reclaim(path: string) {
    const guard = `${path}.reclaim`;
    try {
      await mkdir(guard);
    } catch {
      return;
    }
    try {
      let value: unknown;
      try {
        value = JSON.parse(await readFile(path, "utf8"));
      } catch {
        return;
      }
      if (!isRecord(value) || !Number.isSafeInteger(value.pid) || Number(value.pid) <= 0) return;
      try {
        process.kill(Number(value.pid), 0);
      } catch (error) {
        if (isRecord(error) && error.code === "ESRCH") await unlink(path).catch(() => undefined);
      }
    } finally {
      await rmdir(guard);
    }
  }
}
