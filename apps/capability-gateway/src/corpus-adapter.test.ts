import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { REGISTERED_ADAPTER_IDS, resolveEnabledAdapterIds } from "./adapter-registry.js";
import { corpusModule, replayCorpus } from "./adapters/corpus.js";

const root = fileURLToPath(new URL("../../../fixtures/context-corpus", import.meta.url));
const adapter = (env: NodeJS.ProcessEnv) => corpusModule.create({ env, fetch, db: {} as never, modelProfilesPath: "", workloadToken: (() => { throw new Error("unused"); }) as never, delegate: (() => { throw new Error("unused"); }) as never });
const ctx = { tenantId: "tenant-synthetic", invocationId: "inv-replay-1" };
const lines = (party: string) => readFileSync(`${root}/parties/${party}/records.jsonl`, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const capability = (id: string) => ({ id }) as never;

describe("corpus replay adapter", () => {
  it("is synthetic and never enabled by default", () => {
    expect(corpusModule.sourcePolicyClass).toBe("synthetic");
    expect(REGISTERED_ADAPTER_IDS).not.toContain("corpus");
    expect(resolveEnabledAdapterIds({ GATEWAY_ADAPTERS: "default,corpus" })).toContain("corpus");
  });

  it("reports Missing until CORPUS_ROOT is set, and refuses to run unconfigured", async () => {
    expect((await adapter({}).descriptor("t")).credentialState).toBe("Missing");
    expect((await adapter({ CORPUS_ROOT: root }).descriptor("t")).credentialState).toBe("Configured");
    await expect(adapter({}).invoke("financial.transactions.v1", capability("financial.transactions.v1"), { subject: "H07" }, ctx)).rejects.toThrow("gateway.corpus_not_configured");
  });

  it("serves transactions and scope for a subject entity, as synthetic records citing the invocation", async () => {
    const out = await adapter({ CORPUS_ROOT: root }).invoke("financial.transactions.v1", capability("financial.transactions.v1"), { subject: "h07.entity.owner" }, ctx);
    const body = out.output as { records: any[]; recordGap: unknown; party: string };
    expect(body.party).toBe("H07");
    const expected = lines("H07").filter((r) => r.object_type === "Transaction");
    expect(body.records.filter((r) => r.object_type === "Transaction")).toHaveLength(expected.length);
    expect(body.records.find((r) => r.object_type === "DatasetScope").data).toMatchObject({ complete: true, expected_count: expected.length });
    expect(body.records.every((r) => r.synthetic && r.source_refs[0]?.object_id === "inv-replay-1")).toBe(true);
    expect(out.provider).toBe("corpus");
  });

  it("serves monitoring alerts and treats a quiet hero as a gap", async () => {
    const a = adapter({ CORPUS_ROOT: root });
    const h07 = (await a.invoke("transaction.monitor.v1", capability("transaction.monitor.v1"), { subject: "H07" }, ctx)).output as any;
    expect(h07.records.length).toBe(lines("H07").filter((r) => r.object_type === "Alert").length);
    const h01 = (await a.invoke("transaction.monitor.v1", capability("transaction.monitor.v1"), { subject: "H01" }, ctx)).output as any;
    expect(h01.records).toEqual([]);
    expect(h01.recordGap).not.toBeNull();
  });

  it("replays ownership through the wiring normalizer: edges, synthetic marking, receipt provenance", async () => {
    const out = await adapter({ CORPUS_ROOT: root }).invoke("business.ownership.discover.v1", capability("business.ownership.discover.v1"), { subject: "H04" }, ctx);
    const body = out.output as { records: any[]; recordGap: unknown };
    expect(body.recordGap).toBeNull();
    const records = lines("H04");
    const names = new Map(records.filter((r) => r.object_type === "Entity").map((r) => [r.id, r.data.name]));
    const want = records.filter((r) => r.object_type === "OwnershipInterest")
      .map((r) => `${names.get(r.data.owner)}>${names.get(r.data.owned)}=${r.data.interest}`).sort();
    const replayNames = new Map(body.records.filter((r) => r.object_type === "Entity").map((r) => [r.object_id, r.data.name]));
    const got = body.records.filter((r) => r.object_type === "OwnershipInterest")
      .map((r) => `${replayNames.get(r.data.owner)}>${replayNames.get(r.data.owned)}=${r.data.interest}`).sort();
    expect(got).toEqual(want);
    expect(want).toHaveLength(3);
    expect(body.records.every((r) => r.synthetic)).toBe(true);
    expect(body.records.some((r) => r.source_refs.some((ref: any) => ref.object_type === "GatewayInvocation" && ref.object_id === "inv-replay-1"))).toBe(true);
  });

  it("replays screening: a listed owner is a hit, an unlisted one is negative evidence, a near miss is a candidate", async () => {
    const a = adapter({ CORPUS_ROOT: root });
    const run = async (op: string, subject: string) => (await a.invoke(op, capability(op), { subject }, ctx)).output as { records: any[]; recordGap: unknown };
    const b1 = await run("screening.sanctions.v1", "h06.entity.b1");
    expect(b1.records.filter((r) => r.object_type === "ScreeningHit")).toHaveLength(1);
    expect(b1.records.find((r) => r.object_type === "WatchlistEntry").data).toMatchObject({ name: "Radomir Veselin Kostadinov", list_type: "sanctions" });
    expect(b1.records.find((r) => r.object_type === "ScreeningExecution").data).toMatchObject({ subject: "h06.entity.b1", candidate_count: 1, status: "COMPLETED" });
    const c = await run("screening.sanctions.v1", "h06.entity.c");
    expect(c.records.map((r) => r.object_type).sort()).toEqual(["Entity", "NegativeSearchEvidence", "ScreeningExecution"]);
    // The connector reports both birth dates (1983 against the listed 1969), so the replayed hit carries the
    // conflict the committed record has, and the library will propose FALSE_MATCH_CANDIDATE for a person to confirm.
    const mateo = await run("screening.sanctions.v1", "h02.entity.mateo");
    expect(mateo.records.find((r) => r.object_type === "WatchlistEntry").data.name).toBe("CALDERON RIJO, Jose");
    const mateoHit = mateo.records.find((r) => r.object_type === "ScreeningHit").data;
    expect(mateoHit.features).toEqual({ identifier_conflict: true });
    expect(mateoHit.extensions["ehf.connector"].value.identifier_conflict_basis).toEqual(["birth_date"]);
    // A true designation (same listed identifier and birth date) is never marked as a conflict.
    expect(b1.records.find((r) => r.object_type === "ScreeningHit").data.features).toEqual({ identifier_conflict: false });
    const pep = await run("screening.pep.v1", "h03.entity.chidi");
    expect(pep.records.find((r) => r.object_type === "WatchlistEntry").data.list_type).toBe("pep");
    await expect(a.invoke("screening.sanctions.v1", capability("screening.sanctions.v1"), { subject: "H06" }, ctx)).rejects.toThrow("adapter.corpus_screening_subject_must_be_an_entity");
    await expect(a.invoke("screening.pep.v1", capability("screening.pep.v1"), { subject: "h01.entity.halvorsen" }, ctx)).rejects.toThrow("adapter.corpus_subject_not_screened");
  });

  it("replays ownership ranges and the circular holding", async () => {
    const out = await adapter({ CORPUS_ROOT: root }).invoke("business.ownership.discover.v1", capability("business.ownership.discover.v1"), { subject: "H06" }, ctx);
    const records = (out.output as { records: any[] }).records;
    expect(records.filter((r) => r.object_type === "OwnershipRange")).toHaveLength(1);
    expect(records.filter((r) => r.object_type === "OwnershipInterest")).toHaveLength(7);
    expect(records.filter((r) => r.object_type === "ControlRight")).toHaveLength(1); // Seabright controls Cyprus by voting majority
  });

  it("never claims a complete scope for an account-restricted replay", () => {
    const account = lines("H04").find((r) => r.object_type === "Account" && r.id.endsWith("account.deposit")).id;
    const { output } = replayCorpus(root, "financial.transactions.v1", { subject: "H04", accounts: [account] }, ctx);
    const records = (output as any).records as any[];
    expect(records.find((r) => r.object_type === "DatasetScope").data.complete).toBe(false);
    expect(records.filter((r) => r.object_type === "Transaction").length).toBeLessThan(lines("H04").filter((r) => r.object_type === "Transaction").length);
  });

  it("refuses an unknown subject, a mismatched capability and a tampered corpus", async () => {
    const a = adapter({ CORPUS_ROOT: root });
    await expect(a.invoke("financial.transactions.v1", capability("financial.transactions.v1"), { subject: "nobody" }, ctx)).rejects.toThrow("adapter.corpus_subject_unknown");
    await expect(a.invoke("financial.transactions.v1", capability("financial.transactions.v1"), {}, ctx)).rejects.toThrow("adapter.corpus_subject_missing");
    expect(() => a.assertCapability!(capability("screening.sanctions.v1"), "financial.transactions.v1")).toThrow("corpus_binding_capability_mismatch");
    const copy = mkdtempSync(join(tmpdir(), "corpus-"));
    cpSync(root, copy, { recursive: true });
    const xml = join(copy, "parties/H05/iso20022/camt.053.xml");
    writeFileSync(xml, readFileSync(xml, "utf8").replace("<Amt Ccy=\"USD\">", "<Amt Ccy=\"USD\">9"));
    expect(() => replayCorpus(copy, "financial.transactions.v1", { subject: "H05" }, ctx)).toThrow("corpus.digest_mismatch");
  });
});
