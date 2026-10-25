import { randomUUID, createHash } from "node:crypto";
import { mkdir, writeFile, link, unlink, readFile, readdir, rename, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { isRecord } from "../domain/connections";

const commandQueues = new Map<string, Promise<unknown>>();
// Thrown when another command reclaimed this lock, so the holder must stop before writing anything else.
export class LockLostError extends Error {
  constructor() {
    super("This operation lost its server lock. Its outcome is unconfirmed; check it before retrying.");
    this.name = "LockLostError";
  }
}
export type LockCheck = () => Promise<void>;
export interface LeaseOptions {
  leaseMs?: number;
  heartbeatMs?: number;
  now?: () => number;
  // Operations sharing a queue run one after another before contending for the lock file.
  queues?: Map<string, Promise<unknown>>;
}
// Raycast runs commands in a long-lived process, so a stopped command's pid stays alive;
// the heartbeat tells a live holder from one whose work has stopped.
export class ServerMutex {
  private readonly leaseMs: number;
  private readonly heartbeatMs: number;
  private readonly now: () => number;
  private readonly queues: Map<string, Promise<unknown>>;
  constructor(
    private readonly directory: string,
    private readonly waitMs = 2500,
    { leaseMs = 30000, heartbeatMs = 5000, now = Date.now, queues = commandQueues }: LeaseOptions = {},
  ) {
    this.leaseMs = leaseMs;
    this.heartbeatMs = heartbeatMs;
    this.now = now;
    this.queues = queues;
  }
  async run<T>(id: string, operation: (check: LockCheck) => Promise<T>): Promise<T> {
    const key = join(this.directory, createHash("sha256").update(id).digest("hex"));
    const queues = this.queues;
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
  private beat(path: string, nonce: string) {
    const sidecar = `${path}.${nonce}.heartbeat`;
    const temporary = `${sidecar}.${randomUUID()}`;
    return writeFile(temporary, String(this.now()), { mode: 0o600 })
      .then(() => rename(temporary, sidecar))
      .catch(() => unlink(temporary).catch(() => undefined));
  }
  private async exclusive<T>(path: string, operation: (check: LockCheck) => Promise<T>): Promise<T> {
    await mkdir(this.directory, { recursive: true });
    const owner = `${path}.${process.pid}.${randomUUID()}`;
    const nonce = randomUUID();
    await writeFile(owner, JSON.stringify({ pid: process.pid, nonce }), { flag: "wx", mode: 0o600 });
    let acquired = false;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let beating: Promise<unknown> = Promise.resolve();
    const started = Date.now();
    try {
      // The heartbeat starts before this record is linked as the lock or a reclaim claim, so a stopped attempt always goes stale.
      await this.beat(path, nonce);
      heartbeat = setInterval(() => (beating = this.beat(path, nonce)), this.heartbeatMs);
      heartbeat.unref?.();
      while (!acquired) {
        try {
          await link(owner, path);
          acquired = true;
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
      const check: LockCheck = async () => {
        if ((await this.owner(path))?.nonce !== nonce) throw new LockLostError();
      };
      return await operation(check);
    } finally {
      clearInterval(heartbeat);
      // A beat still writing would recreate the heartbeat file after it is removed.
      await beating;
      if (acquired && (await this.owner(path))?.nonce === nonce) await unlink(path).catch(() => undefined);
      await unlink(`${path}.${nonce}.heartbeat`).catch(() => undefined);
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
  private async stale(path: string, owner: { pid: number; nonce: string }): Promise<boolean> {
    if (this.dead(owner.pid)) return true;
    const beat = await readFile(`${path}.${owner.nonce}.heartbeat`, "utf8").catch(() => undefined);
    // Records without a heartbeat predate the lease and keep the pid-only rule.
    if (beat === undefined) return false;
    const at = Number(beat);
    const fallback = await stat(`${path}.${owner.nonce}.heartbeat`).then(
      (info) => info.mtimeMs,
      () => this.now(),
    );
    return this.now() - (Number.isFinite(at) ? at : fallback) > this.leaseMs;
  }
  // A stopped holder never ran its cleanup, so its owner slot is removed with the lock.
  private async removeOwner(path: string, stale: { pid: number; nonce: string }) {
    const prefix = `${basename(path)}.${stale.pid}.`;
    const names = await readdir(this.directory).catch(() => []);
    for (const name of names)
      if (name.startsWith(prefix) && (await this.owner(join(this.directory, name)))?.nonce === stale.nonce)
        await unlink(join(this.directory, name)).catch(() => undefined);
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
    if (!stale || !(await this.stale(path, stale))) return;
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
        if (!incumbent || !(await this.stale(path, incumbent))) return;
        visited.push(claim);
        nonce = incumbent.nonce;
        continue;
      }
      try {
        const current = await this.owner(path);
        if (current?.nonce === stale.nonce && (await this.stale(path, current))) {
          await unlink(path);
          await unlink(`${path}.${stale.nonce}.heartbeat`).catch(() => undefined);
          await this.removeOwner(path, stale);
        }
      } finally {
        await unlink(claim).catch(() => undefined);
        for (const previous of visited) await unlink(previous).catch(() => undefined);
      }
      return;
    }
  }
}
