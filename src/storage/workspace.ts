import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { isLoopback } from "../domain/connections";

export interface Workspace {
  dir: string;
  ensure: () => Promise<void>;
}

const agents = `# Quick Chat workspace

Waypoint AI starts Quick Chat sessions from Raycast in this folder when no other working directory is chosen.

Use it for quick questions, notes, one-off scripts, small experiments, and drafts. It is not a project repository.

- Keep files small and group related work in subfolders.
- Ask before reading or changing files outside this folder.
`;

// Files are written only when missing, so edits to them are kept.
export async function ensureWorkspace(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  for (const [name, content] of [
    ["AGENTS.md", agents],
    ["CLAUDE.md", "@AGENTS.md\n"],
  ])
    await writeFile(join(dir, name), content, { flag: "wx" }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
    });
}

export function localWorkspace(apiUrl: string, home = homedir()): Workspace | undefined {
  if (!isLoopback(apiUrl)) return undefined;
  const dir = join(home, ".waypoint-ai", "workspace");
  return { dir, ensure: () => ensureWorkspace(dir) };
}
