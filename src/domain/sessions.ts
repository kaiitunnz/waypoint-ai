import { Session } from "../api/sessions";
import { ServerMetadata } from "../api/contracts";

export type SessionFilter = "active" | "all" | "exited";

export function visibleSessions(sessions: Session[], query: string, filter: SessionFilter, metadata?: ServerMetadata) {
  const terms = query.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
  return sessions
    .filter((session) => {
      if (["assistant", "telemetry"].includes(session.source)) return false;
      if (filter === "active" && session.status === "exited") return false;
      if (filter === "exited" && session.status !== "exited") return false;
      const label = metadata?.agents.find((agent) => agent.id === session.backend)?.label ?? "";
      const haystack = [
        session.title,
        session.cwd,
        session.repository,
        session.branch,
        session.backend,
        label,
        session.status,
        session.status !== "exited" ? "active" : "",
      ]
        .join(" ")
        .toLocaleLowerCase();
      return terms.every((term) => haystack.includes(term));
    })
    .sort(
      (a, b) =>
        Number(!!b.pinnedAt) - Number(!!a.pinnedAt) ||
        (a.pinnedAt && b.pinnedAt
          ? b.pinnedAt.localeCompare(a.pinnedAt)
          : b.lastEventAt.localeCompare(a.lastEventAt)) ||
        a.id.localeCompare(b.id),
    );
}

export function isStructured(session: Session, metadata?: ServerMetadata): boolean {
  return metadata?.agents.find((agent) => agent.nativeTransport === session.transport)?.structured === true;
}

export function sessionUrl(frontendUrl: string | undefined, id: string): string | undefined {
  return frontendUrl ? `${frontendUrl}/session/${encodeURIComponent(id)}` : undefined;
}
