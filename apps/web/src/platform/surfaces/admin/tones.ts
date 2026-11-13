import type { IconName } from "@ehf/ui-kit";
import type { Tone } from "@ehf/ui-tokens";

/**
 * Binding, delivery and admin revision states have no stateMap dimension yet (GAP-060),
 * so these surfaces map them here. Positive is used only for a
 * recorded success; anything unrecognised is neutral and shown verbatim (N4, N8).
 */
const TABLES = {
  binding: { DRAFT: ["draft", "file"], VERIFIED: ["info", "check"], ACTIVE: ["positive", "play"], PAUSED: ["attention", "pause"], REVOKED: ["blocking", "block"] },
  delivery: { DELIVERED: ["positive", "check"], PENDING: ["info", "clock"], RETRYING: ["attention", "refresh"], FAILED: ["blocking", "xcircle"], DEAD_LETTERED: ["blocking", "block"] },
  revision: { active: ["positive", "checkcircle"], superseded: ["neutral", "history"], disabled: ["attention", "block"] },
  provider: { active: ["positive", "checkcircle"], disabled: ["attention", "block"] },
  capability: { active: ["positive", "checkcircle"], draft: ["draft", "file"], deprecated: ["neutral", "history"] },
} satisfies Record<string, Record<string, [Tone, IconName]>>;

export type ToneTable = keyof typeof TABLES;

export function localTone(table: ToneTable, value: string | null | undefined): { tone: Tone; icon: IconName; known: boolean } {
  const entry = value ? (TABLES[table] as Record<string, [Tone, IconName]>)[value] : undefined;
  return entry ? { tone: entry[0], icon: entry[1], known: true } : { tone: "neutral", icon: "help", known: false };
}
