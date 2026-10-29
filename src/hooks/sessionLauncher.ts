import { randomUUID } from "node:crypto";
import { ApiError, WaypointClient } from "../api/client";
import { ServerMetadata } from "../api/contracts";
import { Session } from "../api/sessions";
import { ComposeParts, emptyParts } from "../domain/compose";
import {
  ChatDefaults,
  canReattach,
  createRequest,
  customLaunch,
  launchContext,
  ownerTag,
  roleTag,
} from "../domain/quickChat";
import { isStructured } from "../domain/sessions";
import { draftKeys } from "../storage/drafts";
import { LaunchOrigin, QuickChatState, QuickChatStore, setPointer } from "../storage/quickChat";
import { Workspace } from "../storage/workspace";
import { FeedConnection } from "./sessionFeeds";

export interface LaunchDeps {
  connection: FeedConnection;
  client: WaypointClient;
  now: () => number;
  metadata: ServerMetadata;
  workspace?: Workspace;
}

// A password-auth SSH target must be connected before the session can be created.
export class TargetConnectionRequired extends Error {
  constructor(
    readonly targetId: string,
    message: string,
  ) {
    super(message);
  }
}

export type LaunchResult =
  | { kind: "created"; session: Session; compose: ComposeParts; problem?: string }
  | { kind: "rejected"; message: string }
  | { kind: "uncertain"; message: string }
  | { kind: "ssh"; targetId: string; message: string };

// Why Quick Chat can't continue a session: not created by this installation or chosen for it, an interface Raycast
// can't show, or an ended session its interface can't resume.
export function ownershipProblem(
  session: Session,
  saved: QuickChatState,
  metadata: ServerMetadata,
): string | undefined {
  const created = session.tags[ownerTag] === saved.installation && session.tags[roleTag] === "quick-chat";
  if (!created && saved.chosen?.sessionId !== session.id)
    return "The saved destination is not owned by this Quick Chat installation. Choose Start New Chat; your draft is kept.";
  if (!isStructured(session, metadata))
    return "This session uses an unsupported interface. Open it in Waypoint or choose Start New Chat; your draft is kept.";
  if (["exited", "error"].includes(session.status) && !canReattach(session, metadata))
    return "This conversation cannot be resumed by its current interface. Choose Start New Chat; your draft is kept.";
  return undefined;
}

export interface CreateOptions {
  draftKey: string;
  source: "defaults" | "form";
  // The message a send creates the session for; recorded in the checkpoint.
  text?: string;
  origin?: LaunchOrigin;
  // Binds the draft to the created session in the same write that records it.
  bind?: (saved: QuickChatState, session: Session, request: Record<string, unknown>) => void;
  onCreated?: (session: Session) => void;
  // Called once the checkpoint for this attempt is saved, before the request.
  onAttempt?: (operationId: string) => void;
}

// Creates a Quick Chat session inside a server-lock transaction, checkpointed so an unconfirmed create is never
// repeated blindly. The session becomes Quick Chat's destination; a session started from chosen settings counts as
// chosen at creation, so timed reuse runs from then even before its first message.
export async function createInTransaction(
  deps: LaunchDeps,
  saved: QuickChatState,
  persist: () => Promise<void>,
  defaults: ChatDefaults,
  options: CreateOptions,
): Promise<{ session: Session; request: Record<string, unknown>; problem?: string }> {
  const { connection, client, metadata } = deps;
  const workspace = deps.workspace?.dir;
  const form = options.source === "form";
  const context = launchContext(defaults, metadata, workspace);
  const operationId = randomUUID();
  const request = createRequest(defaults, metadata, saved.installation, operationId, {
    workspace,
    createdAt: new Date(deps.now()),
    source: options.source,
  });
  if (workspace && context.cwd === workspace)
    await deps.workspace!.ensure().catch((error: Error) => {
      throw new Error(
        `Could not create the Quick Chat workspace at ${workspace}: ${error.message}.${form ? "" : " Your draft is kept."}`,
      );
    });
  saved.pending = {
    kind: "create",
    operationId,
    text: options.text ?? "",
    draftKey: options.draftKey,
    startedAt: deps.now(),
    ...(options.origin ? { origin: options.origin } : {}),
    launch: { backend: context.backend, target: defaults.target, cwd: context.cwd, title: String(request.title) },
  };
  await persist();
  options.onAttempt?.(operationId);
  let session: Session;
  try {
    session = await client.create(connection.token, request);
  } catch (error) {
    if (error instanceof ApiError && error.kind !== "uncertain") {
      saved.pending = undefined;
      await persist();
    }
    if (error instanceof ApiError && error.detail === "cwd-not-found")
      throw new ApiError(
        "rejected",
        workspace && context.cwd === workspace
          ? `This server can't see the Quick Chat workspace at ${workspace}. Set a ${form ? "working directory" : "Working Directory in Quick Chat Defaults"}.`
          : `${error.message}${form ? "" : " Update Quick Chat Defaults."}`,
        error.detail,
        error.status,
        error.serverDetail,
      );
    const target = metadata.targets.find((entry) => entry.id === defaults.target);
    if (error instanceof ApiError && error.detail === "ssh-master-required" && target?.auth === "password")
      throw new TargetConnectionRequired(target.id, error.message);
    throw error;
  }
  setPointer(saved, session.id, options.origin ? deps.now() : undefined);
  saved.pending = undefined;
  options.bind?.(saved, session, request);
  await persist();
  options.onCreated?.(session);
  return { session, request, problem: ownershipProblem(session, saved, metadata) };
}

function rejectedMessage(error: unknown): string {
  if (
    error instanceof ApiError &&
    error.kind === "rejected" &&
    !error.detail &&
    error.status !== 403 &&
    error.serverDetail
  )
    return `Waypoint: ${error.serverDetail}`;
  return error instanceof Error ? error.message : "Could not start the session.";
}

// Starts a session from chosen settings and binds it to the draft, so the next open continues it until its first
// message. Refusals before anything is sent, such as an unconfirmed operation or a held lock, are thrown.
export async function launchSession(
  deps: LaunchDeps,
  store: QuickChatStore,
  verifyConnection: () => Promise<void>,
  settings: ChatDefaults,
  draftKey: string,
): Promise<LaunchResult> {
  let attempt: string | undefined;
  try {
    const created = await store.transaction(deps.connection.id, async (saved, persist) => {
      if (saved.pending) throw new Error("Check the earlier operation's outcome first.");
      await verifyConnection();
      let compose: ComposeParts = emptyParts();
      const result = await createInTransaction(deps, saved, persist, settings, {
        draftKey,
        source: "form",
        origin: "launch-form",
        onAttempt: (operationId) => (attempt = operationId),
        bind: (state, session) => {
          compose = { ...(state.compose?.[draftKey] ?? emptyParts()), sessionId: session.id, launch: customLaunch };
          state.compose = { ...state.compose, [draftKey]: compose };
        },
      });
      return { ...result, compose };
    });
    // The session exists now, so a failed clear must not turn into a refusal that invites starting it again.
    await store.drafts.write(draftKeys.launch(deps.connection.id), "").catch(() => undefined);
    return { kind: "created", session: created.session, compose: created.compose, problem: created.problem };
  } catch (error) {
    if (error instanceof TargetConnectionRequired) {
      const target = deps.metadata.targets.find((entry) => entry.id === error.targetId);
      return {
        kind: "ssh",
        targetId: error.targetId,
        message: `Connect ${target?.name ?? "the execution target"}, then start the session again.`,
      };
    }
    if (!attempt) throw error;
    const saved = await store.read(deps.connection.id).catch(() => undefined);
    if ((error instanceof ApiError && error.kind === "uncertain") || saved?.pending?.operationId === attempt)
      return {
        kind: "uncertain",
        message: "Waypoint didn't confirm the new session. Check Previous Outcome in Quick Chat before trying again.",
      };
    return { kind: "rejected", message: rejectedMessage(error) };
  }
}
