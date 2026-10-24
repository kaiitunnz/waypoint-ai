import { randomUUID, createHash } from "node:crypto";
import { mkdir, writeFile, link, unlink, readFile } from "node:fs/promises";
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
          await this.reclaim(path, owner);
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
  private async owner(path: string): Promise<{ pid: number; nonce: string } | undefined> {
    try {
      const value: unknown = JSON.parse(await readFile(path, "utf8"));
      if (
        isRecord(value) &&
        Number.isSafeInteger(value.pid) &&
        Number(value.pid) > 0 &&
        typeof value.nonce === "string" &&
        /^[A-Za-z0-9-]{1,128}$/.test(value.nonce)
      )
        return { pid: Number(value.pid), nonce: value.nonce };
    } catch {
      /* An unreadable owner cannot safely be reclaimed. */
    }
    return undefined;
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
    if (!stale || !this.dead(stale.pid)) return;
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
        if (!incumbent || !this.dead(incumbent.pid)) return;
        visited.push(claim);
        nonce = incumbent.nonce;
        continue;
      }
      try {
        const current = await this.owner(path);
        if (current?.nonce === stale.nonce && this.dead(current.pid)) await unlink(path);
      } finally {
        await unlink(claim).catch(() => undefined);
        for (const previous of visited) await unlink(previous).catch(() => undefined);
      }
      return;
    }
  }
}
