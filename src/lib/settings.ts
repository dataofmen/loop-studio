import { eq } from "drizzle-orm";
import { db } from "@/db";
import { appSettings } from "@/db/schema";
import { DEFAULT_MODEL, type AgentCliKind } from "@/lib/agent-cli-meta";
import {
  BATCH_SIZE_RANGE,
  CONCURRENCY_RANGE,
  DEFAULT_SETTINGS,
  clampToRange,
  type AgentSettings,
} from "@/lib/settings-meta";

/**
 * App-wide settings store. Single-user app → a single row (id = 1), no
 * workspace key. No API keys live here: the agent CLI already holds the user's
 * credentials.
 *
 * The shape, bounds and label formatting live in settings-meta.ts so client
 * components can import them without pulling in the database.
 */

export * from "@/lib/settings-meta";

const ROW_ID = 1;

/** Resolves the effective agent settings (row → built-in defaults). */
export async function getAgentSettings(): Promise<AgentSettings> {
  const [row] = await db.select().from(appSettings).where(eq(appSettings.id, ROW_ID)).limit(1);
  if (!row) return DEFAULT_SETTINGS;
  const cli = (row.cli as AgentCliKind) ?? DEFAULT_SETTINGS.cli;
  return {
    cli,
    model: row.model || DEFAULT_MODEL[cli],
    cliPath: row.cliPath || null,
    concurrency: clampToRange(row.concurrency, CONCURRENCY_RANGE),
    batchSize: clampToRange(row.batchSize, BATCH_SIZE_RANGE),
  };
}

export async function saveAgentSettings(patch: {
  cli: AgentCliKind;
  model?: string | null;
  cliPath?: string | null;
  concurrency?: number;
  batchSize?: number;
}): Promise<void> {
  const values: typeof appSettings.$inferInsert = {
    id: ROW_ID,
    cli: patch.cli,
    model: patch.model?.trim() || null,
    cliPath: patch.cliPath?.trim() || null,
    concurrency: clampToRange(patch.concurrency ?? DEFAULT_SETTINGS.concurrency, CONCURRENCY_RANGE),
    batchSize: clampToRange(patch.batchSize ?? DEFAULT_SETTINGS.batchSize, BATCH_SIZE_RANGE),
    updatedAt: new Date(),
  };
  await db
    .insert(appSettings)
    .values(values)
    .onConflictDoUpdate({ target: appSettings.id, set: values });
}
