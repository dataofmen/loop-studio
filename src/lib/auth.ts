import { LOCAL_WORKSPACE_ID } from "@/db/schema";

/**
 * Single-user local app: there is no sign-in and no membership model.
 *
 * `workspace_id` is still carried on every row as a partition key, so this
 * module remains the one place that answers "which workspace am I in?" — it
 * just always answers the same thing. Keeping the async signature means the
 * ~40 call sites don't change, and a future multi-user mode has a seam to
 * plug into.
 *
 * Access control now lives at the network edge: the server binds to 127.0.0.1
 * and is reachable only from the machine running the app.
 */

export { LOCAL_WORKSPACE_ID };

export async function getWorkspaceId(): Promise<string> {
  return LOCAL_WORKSPACE_ID;
}
