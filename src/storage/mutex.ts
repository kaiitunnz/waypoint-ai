import { randomUUID, createHash } from "node:crypto";
import { mkdir, writeFile, link, unlink, readFile } from "node:fs/promises";
import { join } from "node:path";
import { isRecord } from "../domain/connections";

const queues = new Map<string, Promise<unknown>>();
type Owner = { pid: number; nonce: string; heartbeat?: number };
export class ServerMutex {
  constructor(
    private readonly directory: string,
    private readonly waitMs = 2500,
    // A live owner refreshes its heartbeat; a stale one means its worker stopped inside a still-running process.
    private readonly leaseMs = 30000,
    private readonly heartbeatMs = 5000,
    private readonly now = Date.now,
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
    const record = () => JSON.stringify({ pid: process.pid, nonce, heartbeat: this.now() });
    await writeFile(owner, record(), { flag: "wx", mode: 0o600 });
    let acquired = false;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    const started = Date.now();
    try {
      while (!acquired) {
        try {
          await link(owner, path);
          acquired = true;
          // The lock is a hard link to the owner file, so rewriting the owner refreshes the lock in place.
          heartbeat = setInterval(() => void writeFile(owner, record()).catch(() => undefined), this.heartbeatMs);
          heartbeat.unref?.();
        } catch (error) {
          if (!isRecord(error) || error.code !== "EEXIST") throw error;
          await this.reclaim(path, owner);
          if (Date.now() - started >= this.waitMs)
            throw new Error(
              "Another Quick Chat operation, such as an upload, is still active for this server. Retry when it finishes.",
            );
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
      }
      return await operation();
    } finally {
      clearInterval(heartbeat);
      if (acquired) {
        const current: unknown = JSON.parse(await readFile(path, "utf8"));
        if (isRecord(current) && current.nonce === nonce) await unlink(path);
      }
      await unlink(owner).catch(() => undefined);
    }
  }
  private async owner(path: string): Promise<Owner | undefined> {
    try {
      const value: unknown = JSON.parse(await readFile(path, "utf8"));
      if (
        isRecord(value) &&
        Number.isSafeInteger(value.pid) &&
        Number(value.pid) > 0 &&
        typeof value.nonce === "string" &&
        /^[A-Za-z0-9-]{1,128}$/.test(value.nonce)
      )
        return {
          pid: Number(value.pid),
          nonce: value.nonce,
          heartbeat: typeof value.heartbeat === "number" ? value.heartbeat : undefined,
        };
    } catch {
      /* An unreadable owner cannot safely be reclaimed. */
    }
    return undefined;
  }
  private stale(owner: Owner): boolean {
    return this.dead(owner.pid) || (owner.heartbeat !== undefined && this.now() - owner.heartbeat > this.leaseMs);
  }
  private dead(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return false;
    } catch (error) {
      return isRecord(error) && error.code === "ESRCH";
    }
  }
  private async reclaim(path: string, owner: string) {
    const stale = await this.owner(path);
    if (!stale || !this.stale(stale)) return;
    // Immutable claim slots let a successor recover a dead reclaimer without stealing a live claim.
    const visited: string[] = [];
    let nonce = stale.nonce;
    for (let attempt = 0; attempt < 128; attempt++) {
      const claim = `${path}.reclaim.${nonce}`;
      try {
        await link(owner, claim);
      } catch (error) {
        if (!isRecord(error) || error.code !== "EEXIST") throw error;
        const incumbent = await this.owner(claim);
        if (!incumbent || !this.stale(incumbent)) return;
        visited.push(claim);
        nonce = incumbent.nonce;
        continue;
      }
      try {
        const current = await this.owner(path);
        if (current?.nonce === stale.nonce && this.stale(current)) await unlink(path);
      } finally {
        await unlink(claim).catch(() => undefined);
        for (const previous of visited) await unlink(previous).catch(() => undefined);
      }
      return;
    }
  }
}
