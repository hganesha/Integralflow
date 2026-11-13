import { DefinitionLabel, GroupedItems } from "../../presentation/components";
import {
  groupByCategory,
  presentationFor,
  categoryIcon,
} from "../../presentation/model";
import { useEffect, useState, useRef, type ReactNode } from "react";
import {
  Link,
  Navigate,
  useBlocker,
  useNavigate,
} from "@tanstack/react-router";
import { usePolled } from "@ehf/ui-client/react";
import {
  Button,
  Chip,
  EmptyState,
  Field,
  InlineMessage,
  Icon,
  LocalTimestamp,
  Select,
  TextArea,
  TextInput,
  ToneBadge,
  Tabs,
} from "@ehf/ui-kit";
import { ConsoleHeader } from "@ehf/ui-shell";
import type { Schemas } from "@ehf/ui-contracts";
import {
  datasetSchema,
  workspaceFilesSchema,
  workspaceConfig,
} from "@ehf/contracts/workbench";
import { api } from "../../app/api";
import { useSession } from "../../app/session";
import {
  ApiErrorView,
  Freshness,
  Region,
  useCommand,
  useSearchParam,
} from "../common";
import { changesBetween, applyChanges } from "./workbench/draft";
import {
  SKILL_SECTIONS,
  SOURCE_SECTIONS,
  type StudioTab,
} from "./workbench/sections";
import { SourceEditor } from "./workbench/source-editor";
import { sandboxPath, sandboxTestSearch } from "../../studio/sandbox/test-run-path";
import styles from "./workbench/workbench.module.css";

const READS = [["getWorkbenchWorkspace"], ["getWorkbenchWorkspaces"]] as const;
const pretty = (value: unknown) => JSON.stringify(value, null, 2);
type View = Schemas["WorkspaceView"];
type Tab = StudioTab;
export function AgentWorkbench() {
  return <Workbench kind="agent" />;
}
type SkillInformationRenderer = (
  skillId: string,
  section: StudioTab,
) => ReactNode;
export function SkillWorkbench({
  renderSkillInformation,
}: { renderSkillInformation?: SkillInformationRenderer } = {}) {
  return (
    <Workbench kind="skill" renderSkillInformation={renderSkillInformation} />
  );
}
export default function Workbench({
  kind = "skill",
  renderSkillInformation,
}: {
  kind?: "agent" | "skill";
  renderSkillInformation?: SkillInformationRenderer;
}) {
  const [selected, setSelected] = useSearchParam("workspace");
  const navigate = useNavigate();
  const [revision] = useSearchParam("revision");
  const [sourceId] = useSearchParam("source");
  const [librarySearch, setLibrarySearch] = useState("");
  const [navigatorOpen, setNavigatorOpen] = useState(false);
  const libraryRef = useRef<HTMLDivElement>(null);
  const workspaces = usePolled(api, "getWorkbenchWorkspaces");
  const sources = usePolled(api, "getWorkbenchSources");
  const workspace = usePolled(
    api,
    "getWorkbenchWorkspace",
    {
      path: { workspaceId: selected ?? "" },
      query: revision ? { revision: Number(revision) } : {},
    },
    { enabled: Boolean(selected) },
  );
  const session = useSession();
  const activeSource = selected ? workspace.data?.source.config.name : sourceId;
  useEffect(() => {
    const list = libraryRef.current;
    const active = list?.querySelector<HTMLElement>('[data-selected="true"]');
    if (list && active && list.clientHeight)
      list.scrollTop +=
        active.getBoundingClientRect().top -
        list.getBoundingClientRect().top -
        list.clientHeight / 3;
  }, [activeSource, sources.data?.items.length, navigatorOpen]);
  if (workspace.data && workspace.data.workspace.kind !== kind)
    return (
      <Navigate
        to={
          (workspace.data.workspace.kind === "agent"
            ? "/studio/agents"
            : "/studio/skills") as string
        }
        search={
          { workspace: selected, ...(revision ? { revision } : {}) } as never
        }
        replace
      />
    );
  return (
    <div className={styles.page}>
      <ConsoleHeader
        breadcrumb={[
          { label: "Process Studio", href: "/studio" },
          { label: kind === "agent" ? "Agents" : "Skills" },
        ]}
        title={kind === "agent" ? "Agent Studio" : "Skill Studio"}
      />
      <div className={styles.spread}>
        <p className={styles.muted}>
          Browse source, edit files and test exact revisions before publishing.
        </p>
        {selected ? (
          <Freshness polled={workspace} />
        ) : (
          <Freshness polled={workspaces} />
        )}
      </div>
      <div className={styles.libraryToggle}>
        <Button
          icon="stack"
          aria-expanded={navigatorOpen}
          aria-controls="studio-library"
          onClick={() => setNavigatorOpen((value) => !value)}
        >
          Browse {kind === "skill" ? "skills" : "agents"} and workspaces
        </Button>
      </div>
      <div className={styles.grid}>
        <aside
          id="studio-library"
          className={`${styles.stack} ${styles.navigator}`}
          data-open={navigatorOpen || undefined}
        >
          {kind === "skill" ? (
            <section className={styles.card} aria-label="Skill library">
              <h2>Skill library</h2>
              <TextInput
                type="search"
                aria-label="Find a skill"
                placeholder="Find a skill…"
                value={librarySearch}
                onChange={(event) => setLibrarySearch(event.target.value)}
              />
              <Region polled={sources} label="skill library">
                {(data) => (
                  <div className={styles.libraryList} ref={libraryRef}>
                    <GroupedItems
                      items={data.items.filter(
                        (item) =>
                          item.kind === "skill" &&
                          `${item.id} ${item.description}`
                            .toLowerCase()
                            .includes(librarySearch.toLowerCase()),
                      )}
                      kind="skills"
                      idOf={(item) => item.id}
                      categoryOf={(item) => item.category}
                    >
                      {(items) => (
                        <ul className={styles.list}>
                          {items.map((item) => (
                            <li key={item.id}>
                              <Link
                                to={"/studio/skills" as string}
                                search={{ source: item.id } as never}
                                className={styles.workspaceButton}
                                activeOptions={{
                                  exact: true,
                                  includeSearch: true,
                                }}
                                activeProps={{
                                  "aria-current":
                                    activeSource === item.id
                                      ? "page"
                                      : undefined,
                                }}
                                inactiveProps={{
                                  "aria-current":
                                    activeSource === item.id
                                      ? "page"
                                      : undefined,
                                }}
                                data-selected={
                                  activeSource === item.id || undefined
                                }
                                onClick={() => setNavigatorOpen(false)}
                              >
                                <DefinitionLabel
                                  kind="skills"
                                  id={item.id}
                                  title={item.name}
                                  category={item.category}
                                />
                                <span className={styles.muted}>
                                  {item.version}
                                </span>
                              </Link>
                            </li>
                          ))}
                        </ul>
                      )}
                    </GroupedItems>
                  </div>
                )}
              </Region>
            </section>
          ) : null}
          <section className={styles.card}>
            <h2>
              {kind === "agent" ? "Agent workspaces" : "Skill workspaces"}
            </h2>
            <Button
              icon="plus"
              onClick={() => {
                setNavigatorOpen(false);
                void navigate({
                  to: kind === "skill" ? "/studio/skills" : "/studio/agents",
                  search: {},
                } as never);
              }}
            >
              {session.actions.includes("draft.write")
                ? "New workspace"
                : "Browse library"}
            </Button>
            <Region polled={workspaces} label="source workspaces">
              {(data) => (
                <ul className={`${styles.list} ${styles.workspaceList}`}>
                  {([kind] as const).flatMap((kind) =>
                    groupByCategory(
                      data.items.filter((item) => item.kind === kind),
                      kind === "skill" ? "skills" : "agents",
                      (item) => item.name,
                    ).map((group) => (
                      <li key={kind + group.category}>
                        <h3 className={styles.groupTitle}>
                          <Icon name={group.icon} size="sm" />
                          {kind === "skill" ? "Skills" : "Agents"} ·{" "}
                          {group.category}
                        </h3>
                        <ul className={styles.list}>
                          {" "}
                          {group.items.map((item) => (
                            <li key={item.workspaceId}>
                              <button
                                type="button"
                                className={styles.workspaceButton}
                                aria-current={
                                  selected === item.workspaceId
                                    ? "true"
                                    : undefined
                                }
                                onClick={() => {
                                  setNavigatorOpen(false);
                                  void navigate({
                                    to:
                                      kind === "skill"
                                        ? "/studio/skills"
                                        : "/studio/agents",
                                    search: { workspace: item.workspaceId },
                                  } as never);
                                }}
                              >
                                <strong>
                                  <DefinitionLabel
                                    kind={
                                      kind === "skill" ? "skills" : "agents"
                                    }
                                    id={item.name}
                                    title={
                                      presentationFor(
                                        kind === "skill" ? "skills" : "agents",
                                        item.name,
                                      ).title
                                    }
                                  />
                                </strong>
                                <span className={styles.muted}>
                                  {item.kind === "agent" ? "Agent" : "Skill"} ·
                                  revision {item.revision}
                                  {item.publishedRevision
                                    ? ` · published ${item.publishedRevision}`
                                    : ""}
                                </span>
                              </button>
                            </li>
                          ))}
                        </ul>
                      </li>
                    )),
                  )}
                </ul>
              )}
            </Region>
          </section>
          <section className={styles.card}>
            <h2>Connected workflows</h2>
            {kind === "agent" ? (
              <Link to={"/studio/agents/mandates" as string}>
                Browse agent mandates and tasks
              </Link>
            ) : null}
            <Link to={"/studio/drafts" as string}>Draft processes</Link>
            <Link
              to={"/platform/admin" as string}
              search={{ tab: "models" } as never}
            >
              Model profiles
            </Link>
            <Link to={"/catalogs/skills" as string}>Skill catalog</Link>
          </section>
        </aside>
        <div className={styles.stack}>
          {selected ? (
            <Region polled={workspace} label="source workspace">
              {(view) => (
                <Workspace
                  key={selected + ":" + (revision ?? "head")}
                  view={view}
                  historical={Boolean(revision)}
                  renderSkillInformation={renderSkillInformation}
                  catalogSkillId={
                    kind === "skill"
                      ? sources.data?.items.find(
                          (item) =>
                            item.kind === "skill" &&
                            item.id === view.source.config.name,
                        )?.id
                      : undefined
                  }
                />
              )}
            </Region>
          ) : (
            <Region polled={sources} label="available source bundles">
              {(data) =>
                kind === "skill" && sourceId ? (
                  <LibrarySkill
                    key={sourceId}
                    renderSkillInformation={renderSkillInformation}
                    sourceId={sourceId}
                    onCreated={setSelected}
                    workspaces={workspaces.data?.items ?? []}
                  />
                ) : (
                  <CreateWorkspace
                    sources={data.items.filter(
                      (source) => source.kind === kind,
                    )}
                    fixedKind={kind}
                    initialSource={sourceId ?? ""}
                    onCreated={setSelected}
                  />
                )
              }
            </Region>
          )}
        </div>
      </div>
    </div>
  );
}

function LibrarySkill({
  renderSkillInformation,
  sourceId,
  onCreated,
  workspaces,
}: {
  sourceId: string;
  onCreated: (id: string) => void;
  workspaces: Schemas["WorkspaceSummary"][];
  renderSkillInformation?: SkillInformationRenderer;
}) {
  const [tabParam, setTab] = useSearchParam("tab");
  const sections = [
    ...(renderSkillInformation ? SKILL_SECTIONS : []),
    ...SOURCE_SECTIONS,
  ];
  const tab = sections.some((section) => section.value === tabParam)
    ? (tabParam as Tab)
    : renderSkillInformation ? "overview" : "source";
  const session = useSession();
  const create = useCommand("postWorkbenchWorkspaces", { invalidate: READS });
  const bundle = usePolled(
    api,
    "getWorkbenchSource",
    {
      path: { sourceId },
      query: { kind: "skill" },
    },
    { enabled: tab === "source" },
  );
  const existing = workspaces.filter(
    (item) => item.kind === "skill" && item.name === sourceId,
  );
  const open = async () => {
    if (existing[0]) return onCreated(existing[0].workspaceId);
    const result = await create.run({
      body: { kind: "skill", name: sourceId, sourceId },
    });
    if (result) onCreated(result.workspace.workspaceId);
  };
  return (
    <>
      <section className={styles.card}>
        <div className={styles.spread}>
          <h2>
            <DefinitionLabel kind="skills" id={sourceId} />
          </h2>
          <Button
            variant="primary"
            disabled={
              !session.actions.includes("draft.write") && !existing.length
            }
            busy={create.busy}
            onClick={() => void open()}
          >
            {existing.length ? "Open editable workspace" : "Edit skill"}
          </Button>
        </div>
        <p className={styles.muted}>
          Browse the library definition and complete source here. Editing
          creates a workspace with its own saved revisions.
        </p>
        {create.error ? <ApiErrorView error={create.error} /> : null}
      </section>
      <Tabs<Tab>
        label="Skill sections"
        value={tab}
        onChange={(value) => setTab(value === "overview" ? undefined : value)}
        items={sections}
        renderPanel={(section) => (
          <>
            {section === "source" ? (
              <Region polled={bundle} label="skill source files">
                {(data) => (
                  <SourceEditor
                    files={data.files}
                    readOnly
                    onChange={() => undefined}
                  />
                )}
              </Region>
            ) : section === "evaluate" || section === "history" ? (
              <section className={styles.card}>
                <h2>
                  {section === "evaluate"
                    ? "Dataset evaluations"
                    : "Revisions & publication"}
                </h2>
                <p>
                  {section === "evaluate"
                    ? "Evaluate an exact saved source revision against test data in an editable workspace."
                    : "Open a workspace to inspect its saved revisions, evaluation evidence and publication history."}
                </p>
                <Button
                  variant="primary"
                  disabled={
                    !session.actions.includes("draft.write") && !existing.length
                  }
                  busy={create.busy}
                  onClick={() => void open()}
                >
                  {existing.length
                    ? "Open workspace"
                    : "Create editable workspace"}
                </Button>
              </section>
            ) : (
              renderSkillInformation?.(sourceId, section)
            )}
          </>
        )}
      />
    </>
  );
}

function CreateWorkspace({
  sources,
  fixedKind,
  initialSource,
  onCreated,
}: {
  sources: Schemas["WorkspaceSources"]["items"];
  fixedKind: "agent" | "skill";
  initialSource: string;
  onCreated: (id: string) => void;
}) {
  const session = useSession();
  const create = useCommand("postWorkbenchWorkspaces", { invalidate: READS });
  const kind = fixedKind;
  const [name, setName] = useState("");
  const [source, setSource] = useState(initialSource);
  const [filter, setFilter] = useState("");
  const sourceBundle = usePolled(
    api,
    "getWorkbenchSource",
    { path: { sourceId: source || "none" }, query: { kind } },
    { enabled: Boolean(source) },
  );
  const [imported, setImported] = useState<Record<string, string> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const groups = groupByCategory(
    sources.filter((item) => item.kind === kind),
    kind === "skill" ? "skills" : "agents",
    (item) => item.id,
    (item) => item.category,
  );
  return (
    <section className={styles.card}>
      <h2>
        {fixedKind === "agent"
          ? "Create an agent workspace"
          : "Create a skill workspace"}
      </h2>
      <p className={styles.muted}>
        Start from a template, open the full source of a catalog item, or import
        a source bundle.
      </p>
      <Field label="Name">
        <TextInput
          value={name}
          disabled={Boolean(source || imported)}
          onChange={(event) => setName(event.target.value)}
          placeholder={
            kind === "skill"
              ? "Customer name normalization"
              : "Evidence review agent"
          }
        />
      </Field>
      <p className={styles.muted}>
        New templates use this name. Imported bundles retain their source
        definition.
      </p>
      <Field label="Find catalog source">
        <TextInput
          type="search"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          placeholder="Search by name or category…"
        />
      </Field>
      <Field label="Source">
        <Select
          value={source}
          onChange={(event) => {
            setSource(event.target.value);
            setImported(null);
          }}
        >
          <option value="">Blank {kind} template</option>
          {groups.map((group) => (
            <optgroup key={group.category} label={group.category}>
              {group.items
                .filter(
                  (item) =>
                    item.kind === kind &&
                    `${item.name} ${item.description}`
                      .toLowerCase()
                      .includes(filter.toLowerCase()),
                )
                .map((item) => (
                  <option key={item.id} value={item.id}>
                    {
                      presentationFor(
                        kind === "skill" ? "skills" : "agents",
                        item.id,
                        { title: item.name, category: item.category },
                      ).title
                    }{" "}
                    · {item.version}
                  </option>
                ))}
            </optgroup>
          ))}
        </Select>
      </Field>
      {source ? (
        <Region polled={sourceBundle} label="catalog source files">
          {(bundle) => (
            <SourceEditor
              files={bundle.files}
              readOnly
              onChange={() => undefined}
            />
          )}
        </Region>
      ) : null}
      <Field label="Import a source bundle (JSON)">
        <input
          type="file"
          accept=".json,application/json"
          onChange={async (event) => {
            const file = event.target.files?.[0];
            if (!file) return;
            try {
              if (file.size > 10_000_000)
                throw new Error("The source bundle exceeds 10 MB.");
              const data = JSON.parse(await file.text());
              const files = workspaceFilesSchema.parse(
                data.source?.files ?? data.files ?? data,
              );
              setImported(files);
              setSource("");
              setError(null);
            } catch {
              setError(
                "Choose a valid EHF source bundle or a JSON object of file paths and contents.",
              );
            }
          }}
        />
      </Field>
      {imported ? (
        <InlineMessage tone="warn">
          {Object.keys(imported).length} files ready to import.
        </InlineMessage>
      ) : null}
      {error ? <InlineMessage tone="error">{error}</InlineMessage> : null}
      {create.error ? <ApiErrorView error={create.error} /> : null}
      <Button
        variant="primary"
        icon="plus"
        busy={create.busy}
        disabled={
          !session.actions.includes("draft.write") ||
          (!name.trim() && !source && !imported)
        }
        onClick={async () => {
          const result = await create.run({
            body: {
              kind,
              name:
                name.trim() ||
                sources.find((item) => item.id === source)?.name ||
                "Imported workspace",
              ...(source ? { sourceId: source } : {}),
              ...(imported ? { files: imported } : {}),
            },
          });
          if (result) onCreated(result.workspace.workspaceId);
        }}
      >
        {source || imported ? "Import source" : "Create workspace"}
      </Button>
    </section>
  );
}

type LocalEdit = {
  baseRevision: number;
  baseFiles: Record<string, string>;
  files: Record<string, string>;
};
function Workspace({
  view,
  historical,
  catalogSkillId,
  renderSkillInformation,
}: {
  view: View;
  historical: boolean;
  catalogSkillId?: string;
  renderSkillInformation?: SkillInformationRenderer;
}) {
  const session = useSession();
  const [tabParam, setTab] = useSearchParam("tab");
  const sections =
    catalogSkillId && renderSkillInformation
      ? [...SKILL_SECTIONS, ...SOURCE_SECTIONS]
      : [...SOURCE_SECTIONS];
  const tab: Tab = sections.some((section) => section.value === tabParam)
    ? (tabParam as Tab)
    : "source";
  const [_, setRevision] = useSearchParam("revision");
  const key = "ehf:source-draft:v1:" + view.workspace.workspaceId;
  const [local, setLocal] = useState<LocalEdit | null>(() => {
    if (historical) return null;
    try {
      const stored = JSON.parse(sessionStorage.getItem(key) ?? "null");
      if (
        !stored ||
        !Number.isInteger(stored.baseRevision) ||
        !stored.changed ||
        !Array.isArray(stored.deleted)
      )
        return null;
      const files = applyChanges(view.source.files, stored);
      return workspaceFilesSchema.safeParse(files).success
        ? {
            baseRevision: stored.baseRevision,
            baseFiles: view.source.files,
            files,
          }
        : null;
    } catch {
      return null;
    }
  });
  const [evaluationDraft, setEvaluationDraft] = useState(() => ({
    dataset:
      view.source.files["tests/dataset.json"] ??
      pretty({
        name: "Test dataset",
        version: "1",
        cases: [{ id: "example", input: {}, expected: {} }],
      }),
    profile: view.source.config.modelProfileId ?? "",
    budget: "1",
  }));
  const [recoveryAvailable, setRecoveryAvailable] = useState(true);
  const [message, setMessage] = useState("");
  const [error, setError] = useState<string | null>(null);
  const save = useCommand("putWorkbenchWorkspace", { invalidate: READS });
  const files = local?.files ?? view.source.files;
  const dirty = local !== null;
  const canWrite = session.actions.includes("draft.write") && !historical;
  useEffect(() => {
    if (historical) return;
    try {
      if (local)
        sessionStorage.setItem(
          key,
          JSON.stringify({
            baseRevision: local.baseRevision,
            ...changesBetween(local.baseFiles, local.files),
          }),
        );
      else sessionStorage.removeItem(key);
      setRecoveryAvailable(true);
    } catch {
      setRecoveryAvailable(false);
      try {
        sessionStorage.removeItem(key);
      } catch {}
    }
  }, [key, local, historical]);
  const blocker = useBlocker({
    shouldBlockFn: ({ current, next }) => {
      const before = current.search as Record<string, unknown>;
      const after = next.search as Record<string, unknown>;
      return (
        dirty &&
        (current.pathname !== next.pathname ||
          before.workspace !== after.workspace ||
          before.revision !== after.revision)
      );
    },
    withResolver: true,
    enableBeforeUnload: dirty,
  });
  async function download() {
    const result = await api.getWorkbenchExport({
      path: { workspaceId: view.workspace.workspaceId },
      query: { revision: view.source.revision },
    });
    const url = URL.createObjectURL(
      new Blob([pretty(result)], { type: "application/json" }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = `${view.workspace.workspaceId}-r${view.source.revision}.json`;
    link.click();
    URL.revokeObjectURL(url);
  }
  return (
    <>
      <section className={styles.card}>
        <div className={styles.spread}>
          <div>
            <h2>
              <DefinitionLabel
                kind={view.source.config.kind === "skill" ? "skills" : "agents"}
                id={view.source.config.name}
              />
            </h2>
            <p className={styles.muted}>
              {view.source.config.kind === "agent" ? "Agent" : "Business skill"}{" "}
              · {view.source.config.version} · source revision{" "}
              {view.source.revision}
            </p>
          </div>
          <div className={styles.row}>
            <Chip outline>
              {view.workspace.publishedRevision === view.source.revision
                ? "Published"
                : "Draft"}
            </Chip>
            <Button size="sm" onClick={() => void download()}>
              Export bundle
            </Button>
          </div>
        </div>
        <p className={styles.muted}>{view.source.config.description}</p>
        <p className={styles.muted}>
          Evaluations use workbench.json, the selected entrypoint and
          instruction files. Imported deployment definitions remain available
          for review.
        </p>
      </section>
      {historical ? (
        <InlineMessage tone="warn">
          Viewing immutable revision {view.source.revision}.{" "}
          <Button size="sm" onClick={() => setRevision(undefined)}>
            Open latest revision
          </Button>
          {session.actions.includes("draft.write") ? (
            <Button
              size="sm"
              onClick={async () => {
                const result = await save.run({
                  path: { workspaceId: view.workspace.workspaceId },
                  body: {
                    expectedRevision: view.workspace.revision,
                    message: `Restore revision ${view.source.revision}`,
                    files: view.source.files,
                  },
                });
                if (result) setRevision(undefined);
              }}
            >
              Restore as a new revision
            </Button>
          ) : null}
        </InlineMessage>
      ) : null}
      {dirty ? (
        <div className={styles.dirty}>
          <span>Unsaved changes · based on revision {local.baseRevision}</span>
          <Button size="sm" onClick={() => setLocal(null)}>
            Discard local changes
          </Button>
        </div>
      ) : null}
      {dirty && local.baseRevision !== view.workspace.revision ? (
        <section className={styles.card}>
          <InlineMessage tone="warn">
            The server is at revision {view.workspace.revision}. Your local
            edits are preserved. Compare the source before saving on the newer
            revision.
          </InlineMessage>
          <Button
            onClick={() =>
              setLocal({
                baseRevision: view.workspace.revision,
                baseFiles: view.source.files,
                files: applyChanges(
                  view.source.files,
                  changesBetween(local.baseFiles, local.files),
                ),
              })
            }
          >
            Apply my changed files to revision {view.workspace.revision}
          </Button>
        </section>
      ) : null}
      {save.error ? <ApiErrorView error={save.error} /> : null}
      {error ? <InlineMessage tone="error">{error}</InlineMessage> : null}
      <Tabs<Tab>
        label="Workspace sections"
        value={tab}
        onChange={(value) => setTab(value === "source" ? undefined : value)}
        items={sections}
        renderPanel={() => (
          <>
            {tab === "source" ? (
              <>
                {view.source.config.kind === "agent" ? (
                  <AgentSkills
                    files={files}
                    disabled={!canWrite || save.busy}
                    onChange={(next) =>
                      setLocal((current) => ({
                        baseRevision:
                          current?.baseRevision ?? view.source.revision,
                        baseFiles: current?.baseFiles ?? view.source.files,
                        files: next,
                      }))
                    }
                  />
                ) : null}
                <SourceEditor
                  files={files}
                  baseFiles={view.source.files}
                  readOnly={!canWrite || save.busy}
                  onChange={(next) =>
                    setLocal((current) => ({
                      baseRevision:
                        current?.baseRevision ?? view.source.revision,
                      baseFiles: current?.baseFiles ?? view.source.files,
                      files: next,
                    }))
                  }
                />
                {canWrite ? (
                  <section className={styles.card}>
                    <Field label="Revision message">
                      <TextInput
                        value={message}
                        onChange={(event) => setMessage(event.target.value)}
                        placeholder="Describe the source change"
                      />
                    </Field>
                    <div className={styles.row}>
                      <Button
                        variant="primary"
                        busy={save.busy}
                        disabled={
                          !dirty ||
                          !message.trim() ||
                          local.baseRevision !== view.workspace.revision
                        }
                        onClick={async () => {
                          if (!local) return;
                          const valid = workspaceFilesSchema.safeParse(files);
                          if (!valid.success)
                            return setError(
                              valid.error.issues[0]?.message ??
                                "Invalid files.",
                            );
                          const result = await save.run({
                            path: { workspaceId: view.workspace.workspaceId },
                            body: {
                              expectedRevision: local.baseRevision,
                              message,
                              files,
                            },
                          });
                          if (result) {
                            setLocal(null);
                            setMessage("");
                            setError(null);
                          }
                        }}
                      >
                        Save new revision
                      </Button>
                      <span className={styles.muted}>
                        Published revisions stay unchanged.
                      </span>
                    </div>
                  </section>
                ) : null}
              </>
            ) : tab === "evaluate" ? (
              <Evaluations
                view={view}
                dirty={dirty}
                draft={evaluationDraft}
                onDraft={setEvaluationDraft}
              />
            ) : tab === "history" ? (
              <History
                view={view}
                dirty={dirty}
                onRevision={(revision) => setRevision(String(revision))}
              />
            ) : catalogSkillId ? (
              renderSkillInformation?.(catalogSkillId, tab)
            ) : null}
          </>
        )}
      />
      {blocker.status === "blocked" ? (
        <section
          role="alertdialog"
          aria-label="Unsaved source changes"
          className={styles.card}
        >
          <h2>Keep your source edits?</h2>
          <p>
            {recoveryAvailable
              ? "Leaving keeps a local recovery copy of your changed files. Save a revision to share them."
              : "Local recovery is unavailable. Save a revision before leaving to keep your edits."}
          </p>
          <div className={styles.row}>
            <Button variant="primary" onClick={() => blocker.reset()}>
              Continue editing
            </Button>
            <Button onClick={() => blocker.proceed()}>
              {recoveryAvailable
                ? "Leave with recovery copy"
                : "Discard and leave"}
            </Button>
          </div>
        </section>
      ) : null}
    </>
  );
}

function AgentSkills({
  files,
  onChange,
  disabled,
}: {
  files: Record<string, string>;
  onChange: (files: Record<string, string>) => void;
  disabled: boolean;
}) {
  const skills = usePolled(api, "getWorkbenchWorkspaces");
  const [selected, setSelected] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  let config;
  try {
    config = workspaceConfig(files);
  } catch {
    return null;
  }
  const current = config;
  return (
    <section className={styles.card}>
      <h3>Attached skill revisions</h3>
      <p className={styles.muted}>
        Agents execute these exact source digests during dataset evaluations.
        Publish each skill before publishing the agent.
      </p>
      <GroupedItems
        items={current.skillRefs}
        kind="skills"
        idOf={(pin) =>
          skills.data?.items.find((item) => item.workspaceId === pin.id)
            ?.name ?? pin.id
        }
      >
        {(pins) => (
          <ul className={styles.list}>
            {pins.map((pin) => (
              <li key={pin.id} className={styles.spread}>
                <span>
                  {skills.data?.items.find(
                    (item) => item.workspaceId === pin.id,
                  )?.name ?? pin.id}{" "}
                  · {pin.version} <code>{pin.digest.slice(0, 12)}</code>
                </span>
                <Button
                  size="sm"
                  disabled={disabled}
                  onClick={() =>
                    onChange({
                      ...files,
                      "workbench.json": pretty({
                        ...current,
                        skillRefs: current.skillRefs.filter(
                          (item) => item.id !== pin.id,
                        ),
                      }),
                    })
                  }
                >
                  Detach
                </Button>
              </li>
            ))}
          </ul>
        )}
      </GroupedItems>
      <Field label="Skill workspace">
        <Select
          value={selected}
          disabled={disabled}
          onChange={(event) => setSelected(event.target.value)}
        >
          <option value="">Select a skill</option>
          {groupByCategory(
            (skills.data?.items ?? []).filter(
              (item) =>
                item.kind === "skill" &&
                !current.skillRefs.some((pin) => pin.id === item.workspaceId),
            ),
            "skills",
            (item) => item.name,
          ).map((group) => (
            <optgroup key={group.category} label={group.category}>
              {group.items.map((item) => (
                <option key={item.workspaceId} value={item.workspaceId}>
                  {presentationFor("skills", item.name).title} · revision{" "}
                  {item.publishedRevision ?? item.revision}
                  {item.publishedRevision ? " · published" : " · draft"}
                </option>
              ))}
            </optgroup>
          ))}
        </Select>
      </Field>
      <Button
        size="sm"
        busy={busy}
        disabled={disabled || !selected}
        onClick={async () => {
          setBusy(true);
          setError(null);
          try {
            const item = skills.data?.items.find(
              (item) => item.workspaceId === selected,
            );
            const source = await api.getWorkbenchWorkspace({
              path: { workspaceId: selected },
              query: item?.publishedRevision
                ? { revision: item.publishedRevision }
                : {},
            });
            onChange({
              ...files,
              "workbench.json": pretty({
                ...current,
                skillRefs: [
                  ...current.skillRefs,
                  {
                    id: selected,
                    version: source.source.config.version,
                    digest: source.source.digest,
                  },
                ],
              }),
            });
            setSelected("");
          } catch {
            setError("The selected source revision could not be loaded.");
          } finally {
            setBusy(false);
          }
        }}
      >
        Attach exact revision
      </Button>
      {error ? <InlineMessage tone="error">{error}</InlineMessage> : null}
    </section>
  );
}

type EvaluationDraft = { dataset: string; profile: string; budget: string };
function Evaluations({
  view,
  dirty,
  draft,
  onDraft,
}: {
  view: View;
  dirty: boolean;
  draft: EvaluationDraft;
  onDraft: (draft: EvaluationDraft) => void;
}) {
  const session = useSession();
  const profiles = usePolled(api, "getGatewayProfiles");
  const run = useCommand("postWorkbenchEvaluation", { invalidate: READS });
  const cancel = useCommand("postWorkbenchCancel", { invalidate: READS });
  const { dataset, profile, budget } = draft;
  const setDataset = (dataset: string) => onDraft({ ...draft, dataset });
  const setProfile = (profile: string) => onDraft({ ...draft, profile });
  const setBudget = (budget: string) => onDraft({ ...draft, budget });
  const [error, setError] = useState<string | null>(null);
  return (
    <section className={styles.card}>
      <h2>Test source revision {view.source.revision}</h2>
      <p className={styles.muted}>
        Run the saved source against versioned test data. Each case needs an
        expected output or assertions. Structural workflow checks remain in the
        workflow draft.
      </p>
      {dirty ? (
        <InlineMessage tone="warn">
          Save your source changes before evaluating them.
        </InlineMessage>
      ) : null}
      {view.source.config.engine === "agent" ? (
        <>
          <Field label="Model profile">
            <Select
              value={profile}
              onChange={(event) => setProfile(event.target.value)}
            >
              <option value="">Select a model profile</option>
              {profiles.data?.items.map((item) => (
                <option key={item.tierId} value={item.tierId}>
                  {item.tierId} · {item.resolvedOpenRouterModel}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Evaluation budget (USD)">
            <TextInput
              type="number"
              min="0.01"
              max="100"
              step="0.01"
              value={budget}
              onChange={(event) => setBudget(event.target.value)}
            />
          </Field>
          <p className={styles.muted}>
            Model evaluations test the saved prompt and response schema.
            Attached skills run against supplied fixtures. Provider fixtures
            stay inside the source container; live case writes are unavailable.
          </p>
        </>
      ) : (
        <p className={styles.muted}>
          Code runs in a disposable container with dataset input and no network
          access.
        </p>
      )}
      <Button
        size="sm"
        onClick={() =>
          setDataset(
            view.source.files["tests/dataset.json"] ??
              pretty({
                name: "Test dataset",
                version: "1",
                cases: [{ id: "example", input: {}, expected: {} }],
              }),
          )
        }
      >
        Use saved dataset
      </Button>
      <Field label="Load dataset JSON">
        <input
          type="file"
          accept=".json,application/json"
          onChange={async (event) => {
            const file = event.target.files?.[0];
            if (file && file.size <= 2_000_000) setDataset(await file.text());
            else if (file) setError("Dataset files must be under 2 MB.");
          }}
        />
      </Field>
      <Field label="Dataset (JSON)">
        <TextArea
          mono
          rows={12}
          value={dataset}
          onChange={(event) => setDataset(event.target.value)}
        />
      </Field>
      <p className={styles.muted}>
        Assertions support JSON Pointer paths with equals, contains and exists
        operators.
      </p>
      {error ? <InlineMessage tone="error">{error}</InlineMessage> : null}
      {run.error ? <ApiErrorView error={run.error} /> : null}
      {cancel.error ? <ApiErrorView error={cancel.error} /> : null}
      <Button
        variant="primary"
        icon="play"
        busy={run.busy}
        disabled={
          dirty ||
          !session.actions.includes("draft.evaluate") ||
          (view.source.config.engine === "agent" && !profile)
        }
        onClick={async () => {
          try {
            const input = datasetSchema.parse(JSON.parse(dataset));
            setError(null);
            await run.run({
              path: { workspaceId: view.workspace.workspaceId },
              body: {
                revision: view.source.revision,
                dataset: input,
                modelProfileId:
                  view.source.config.engine === "agent" ? profile : null,
                maxCostUsd:
                  view.source.config.engine === "agent" ? Number(budget) : 0,
              },
            });
          } catch {
            setError(
              "Check dataset JSON: include a name, version and uniquely named cases with input and expected output or assertions.",
            );
          }
        }}
      >
        Run dataset evaluation
      </Button>
      <h3>Evaluation history</h3>
      <p className={styles.muted}>
        The latest 10 evaluations and release evidence for this revision.
      </p>
      {!view.evaluations.length ? (
        <EmptyState icon="beaker" title="No evaluations yet" headingLevel={3} />
      ) : null}
      <div className={styles.results}>
        {view.evaluations.map((report) => (
          <details
            className={styles.result}
            key={report.evaluationId}
            open={report.status === "running" || report.status === "queued"}
          >
            <summary>
              <strong>
                Revision {report.revision} · {report.dataset.name}{" "}
                {report.dataset.version}
              </strong>{" "}
              ·{" "}
              <ToneBadge
                icon={
                  report.status === "passed"
                    ? "checkcircle"
                    : report.status === "failed" || report.status === "error"
                      ? "xcircle"
                      : "clock"
                }
                tone={
                  report.status === "passed"
                    ? "positive"
                    : report.status === "failed" || report.status === "error"
                      ? "blocking"
                      : "neutral"
                }
              >
                {report.status}
              </ToneBadge>
            </summary>
            <p className={styles.muted}>
              {report.actor} · <LocalTimestamp iso={report.createdAt} /> ·{" "}
              {report.modelProfileId
                ? `${report.modelProfileId}, revision ${report.modelProfileRevision}`
                : "Source code"}
            </p>
            <p className={styles.muted}>
              Source <code>{report.sourceDigest}</code>
              <br />
              Dataset <code>{report.datasetDigest}</code>
            </p>
            <Link to={sandboxPath(report.evaluationId)} search={sandboxTestSearch("probe", view.workspace.workspaceId)}>Inspect in Sandbox Studio</Link>
            {report.error ? (
              <InlineMessage tone="error">{report.error}</InlineMessage>
            ) : null}
            {(report.status === "queued" || report.status === "running") &&
            session.actions.includes("draft.evaluate") ? (
              <Button
                size="sm"
                busy={cancel.busy}
                onClick={() =>
                  void cancel.run({
                    path: { evaluationId: report.evaluationId },
                  })
                }
              >
                Cancel evaluation
              </Button>
            ) : null}
            {report.cases.map((test) => (
              <details className={styles.result} key={test.id}>
                <summary>
                  {test.id} · {test.status} · {test.durationMs} ms
                </summary>
                {test.failures.map((failure, index) => (
                  <p key={index}>{failure}</p>
                ))}
                <div className={styles.diff}>
                  <div>
                    <h4>Expected</h4>
                    <pre>{pretty(test.expected)}</pre>
                  </div>
                  <div>
                    <h4>Actual</h4>
                    <pre>{pretty(test.actual)}</pre>
                  </div>
                </div>
                <p className={styles.muted}>
                  Tokens {test.inputTokens ?? "—"} in /{" "}
                  {test.outputTokens ?? "—"} out · Cost{" "}
                  {test.costUsd === null ? "Not reported" : `$${test.costUsd}`}
                </p>
                {test.receipts.map((receipt, index) => (
                  <details key={index} className={styles.result}>
                    <summary>
                      Skill {receipt.skillId} · {receipt.durationMs} ms ·{" "}
                      {receipt.sourceDigest.slice(0, 12)}
                    </summary>
                    <pre>
                      {pretty({ input: receipt.input, output: receipt.output })}
                    </pre>
                  </details>
                ))}
                {test.traceId ? (
                  <span className={styles.muted}>
                    Trace <code>{test.traceId}</code>
                  </span>
                ) : null}
              </details>
            ))}
          </details>
        ))}
      </div>
    </section>
  );
}

function History({
  view,
  dirty,
  onRevision,
}: {
  view: View;
  dirty: boolean;
  onRevision: (revision: number) => void;
}) {
  const session = useSession();
  const promote = useCommand("postWorkbenchPromotion", { invalidate: READS });
  const [reason, setReason] = useState("");
  const approval = view.promotions.find(
    (item) =>
      item.revision === view.source.revision && item.operation === "approve",
  );
  const report = view.evaluations.find(
    (item) =>
      item.revision === view.source.revision &&
      item.sourceDigest === view.source.digest &&
      item.status === "passed" &&
      (!approval || approval.evaluationId === item.evaluationId),
  );
  const approved = view.promotions.some(
    (item) =>
      item.revision === view.source.revision &&
      item.operation === "approve" &&
      item.evaluationId === report?.evaluationId,
  );
  const selfAuthored = view.history.some(
    (item) => item.actor === session.subject.subjectId,
  );
  return (
    <section className={styles.card}>
      <h2>Revisions & publication</h2>
      <p className={styles.muted}>
        Every saved source revision and evaluation keeps its own digest.
        Publishing creates a source release; running plans retain their existing
        pins until deployment.
      </p>
      <ul className={styles.list}>
        {view.history.map((item) => (
          <li key={item.revision} className={styles.result}>
            <div className={styles.spread}>
              <strong>
                Revision {item.revision} · {item.message}
              </strong>
              <Button size="sm" onClick={() => onRevision(item.revision)}>
                View revision {item.revision}
              </Button>
            </div>
            <p className={styles.muted}>
              {item.actor} · <LocalTimestamp iso={item.createdAt} />
            </p>
            <code>{item.digest}</code>
          </li>
        ))}
      </ul>
      <h3>Release revision {view.source.revision}</h3>
      {!report ? (
        <InlineMessage tone="warn">
          A passing dataset evaluation of this exact source revision is
          required.
        </InlineMessage>
      ) : (
        <InlineMessage tone="ok">
          A passing evaluation is recorded for this source digest.
        </InlineMessage>
      )}
      {selfAuthored ? (
        <InlineMessage tone="warn">
          A different reviewer must approve and publish your source changes.
        </InlineMessage>
      ) : null}
      <Field label="Review reason">
        <TextInput
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          placeholder="Record the review outcome"
        />
      </Field>
      <div className={styles.row}>
        {(["approve", "publish"] as const).map((operation) => (
          <Button
            key={operation}
            variant={operation === "publish" ? "primary" : "secondary"}
            busy={promote.busy}
            disabled={
              dirty ||
              !report ||
              selfAuthored ||
              reason.trim().length < 3 ||
              !session.actions.includes(
                operation === "approve" ? "draft.approve" : "draft.publish",
              ) ||
              (operation === "publish" && !approved) ||
              (operation === "approve" && approved) ||
              view.workspace.publishedRevision === view.source.revision
            }
            onClick={() => {
              if (report)
                void promote.run({
                  path: { workspaceId: view.workspace.workspaceId },
                  body: {
                    revision: view.source.revision,
                    operation,
                    evaluationId: report.evaluationId,
                    reason,
                  },
                });
            }}
          >
            {operation === "approve"
              ? "Approve revision"
              : "Publish source bundle"}
          </Button>
        ))}
      </div>
      {promote.error ? <ApiErrorView error={promote.error} /> : null}
      {view.promotions.map((item) => (
        <p key={item.revision + item.operation} className={styles.muted}>
          Revision {item.revision} · {item.operation} by {item.actor} ·{" "}
          {item.reason}
        </p>
      ))}
    </section>
  );
}
