import { randomUUID } from "node:crypto";
import { mkdir, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { clipboardImageName } from "../domain/compose";

export interface ClipboardReferences {
  referencedClipboardIds(ids: string[]): Promise<Set<string>>;
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// Long enough for another command to save a draft naming a file it just wrote, and for clock skew.
const graceMs = 60 * 60 * 1000;
const sweepEveryMs = 10 * 60 * 1000;

// Images saved from the clipboard, one directory each so the uploaded name reads well. Only directories under the
// root are deleted: at once for an image that never entered a draft, otherwise once no server's saved state names it.
export class ClipboardFiles {
  private readonly running = new Set<Promise<void>>();
  private readonly root: string;
  constructor(
    root: string,
    private readonly references: ClipboardReferences,
    private readonly now = Date.now,
  ) {
    this.root = resolve(root);
  }
  async create(date: Date): Promise<{ id: string; path: string }> {
    const id = randomUUID();
    await mkdir(join(this.root, id), { recursive: true });
    return { id, path: join(this.root, id, clipboardImageName(date)) };
  }
  ownedId(path: string): string | undefined {
    const parts = relative(this.root, resolve(path)).split(sep);
    return parts.length === 2 && uuid.test(parts[0]) ? parts[0] : undefined;
  }
  // For a file that never entered a draft.
  discard(id: string): Promise<void> {
    return this.track(this.remove([id]));
  }
  // Deletes the owned files among these paths that no saved state mentions anymore.
  release(paths: string[]): Promise<void> {
    const ids = [...new Set(paths.map((path) => this.ownedId(path)).filter((id): id is string => !!id))];
    return ids.length ? this.track(this.removeUnreferenced(ids)) : Promise.resolve();
  }
  // Collects files a crash, another process, or a removed draft left behind. Raycast starts a process per command,
  // so the throttle is a marker file shared by all of them.
  sweep(): Promise<void> {
    return this.track(this.collect());
  }
  // Resolves once cleanup started so far has finished.
  async settled(): Promise<void> {
    while (this.running.size) await Promise.all(this.running);
  }
  private track(work: Promise<void>): Promise<void> {
    const done = work.catch(() => undefined);
    this.running.add(done);
    void done.then(() => this.running.delete(done));
    return done;
  }
  private async collect() {
    const marker = join(this.root, ".swept");
    const swept = await stat(marker).catch(() => undefined);
    if (swept && this.now() - swept.mtimeMs < sweepEveryMs) return;
    const entries = await readdir(this.root, { withFileTypes: true }).catch(() => undefined);
    if (!entries) return;
    const time = new Date(this.now());
    await writeFile(marker, "");
    await utimes(marker, time, time);
    const old: string[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !uuid.test(entry.name)) continue;
      const info = await stat(join(this.root, entry.name)).catch(() => undefined);
      if (info && this.now() - info.mtimeMs > graceMs) old.push(entry.name);
    }
    if (old.length) await this.removeUnreferenced(old);
  }
  private async removeUnreferenced(ids: string[]) {
    const referenced = await this.references.referencedClipboardIds(ids);
    await this.remove(ids.filter((id) => !referenced.has(id)));
  }
  private async remove(ids: string[]) {
    await Promise.all(
      ids.map((id) => {
        const directory = join(this.root, id);
        return uuid.test(id) && dirname(directory) === this.root
          ? rm(directory, { recursive: true, force: true })
          : undefined;
      }),
    );
  }
}
