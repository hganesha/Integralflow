import { memo, useMemo, useState } from "react";
import {
  Button,
  Field,
  Icon,
  InlineMessage,
  TextArea,
  TextInput,
} from "@ehf/ui-kit";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  sourcePathSchema,
  workspaceFilesSchema,
} from "@ehf/contracts/workbench";
import styles from "./workbench.module.css";

type Tree = { files: string[]; folders: Map<string, Tree> };
export function fileTree(paths: string[]): Tree {
  const root: Tree = { files: [], folders: new Map() };
  for (const path of [...paths].sort()) {
    const parts = path.split("/");
    let node = root;
    for (const part of parts.slice(0, -1)) {
      if (!node.folders.has(part))
        node.folders.set(part, { files: [], folders: new Map() });
      node = node.folders.get(part)!;
    }
    node.files.push(path);
  }
  return root;
}
const TreeRows = memo(function TreeRows({
  tree,
  selected,
  onSelect,
  prefix = "",
  forceOpen = false,
}: {
  tree: Tree;
  selected: string;
  onSelect: (path: string) => void;
  prefix?: string;
  forceOpen?: boolean;
}) {
  return (
    <ul className={styles.treeList}>
      {[...tree.folders].map(([name, child]) => (
        <li key={name}>
          <details open={forceOpen || selected.startsWith(prefix + name + "/")}>
            <summary>
              <Icon name="folder" size="sm" />
              {name}
            </summary>
            <TreeRows
              tree={child}
              selected={selected}
              onSelect={onSelect}
              prefix={prefix + name + "/"}
              forceOpen={forceOpen}
            />
          </details>
        </li>
      ))}
      {tree.files.map((path) => (
        <li key={path}>
          <button
            type="button"
            className={styles.file}
            aria-current={selected === path ? "true" : undefined}
            onClick={() => onSelect(path)}
          >
            <Icon name="file" size="sm" />
            <span>{path.slice(prefix.length)}</span>
          </button>
        </li>
      ))}
    </ul>
  );
});

export function SourceEditor({
  files,
  baseFiles,
  onChange,
  readOnly = false,
  protectedFiles = ["workbench.json"],
}: {
  files: Record<string, string>;
  baseFiles?: Record<string, string>;
  onChange: (files: Record<string, string>) => void;
  readOnly?: boolean;
  protectedFiles?: string[];
}) {
  const [selected, setSelected] = useState(
    Object.hasOwn(files, "SKILL.md")
      ? "SKILL.md"
      : Object.hasOwn(files, "AGENT.md")
        ? "AGENT.md"
        : (Object.keys(files).sort()[0] ?? ""),
  );
  const [filter, setFilter] = useState("");
  const [path, setPath] = useState("");
  const [mode, setMode] = useState<"edit" | "preview" | "diff">("edit");
  const [error, setError] = useState<string | null>(null);
  const paths = Object.keys(files).filter((name) =>
    name.toLowerCase().includes(filter.toLowerCase()),
  );
  const pathKey = paths.join("\0");
  const tree = useMemo(
    () => fileTree(pathKey ? pathKey.split("\0") : []),
    [pathKey],
  );
  const active = Object.hasOwn(files, selected) ? selected : (paths[0] ?? "");
  const content = files[active] ?? "";
  function create(folder = false) {
    const target = folder ? path.replace(/\/$/, "") + "/.gitkeep" : path;
    if (!sourcePathSchema.safeParse(target).success)
      return setError("Enter a relative file or folder path.");
    if (
      Object.hasOwn(files, target) ||
      Object.keys(files).some((file) => file.startsWith(target + "/"))
    )
      return setError("That path already exists.");
    if (
      folder &&
      Object.keys(files).some((file) =>
        file.startsWith(path.replace(/\/$/, "") + "/"),
      )
    )
      return setError("That folder already exists.");
    const next = { ...files, [target]: "" };
    const valid = workspaceFilesSchema.safeParse(next);
    if (!valid.success)
      return setError(valid.error.issues[0]?.message ?? "Invalid file path.");
    onChange(next);
    setSelected(target);
    setPath("");
    setFilter("");
    setError(null);
  }
  function rename() {
    if (protectedFiles.includes(active))
      return setError("This file is required by the workspace.");
    if (!sourcePathSchema.safeParse(path).success || Object.hasOwn(files, path))
      return setError("Enter a new, valid path.");
    const copy = { ...files };
    delete copy[active];
    copy[path] = content;
    const valid = workspaceFilesSchema.safeParse(copy);
    if (!valid.success)
      return setError(valid.error.issues[0]?.message ?? "Invalid file move.");
    onChange(copy);
    setSelected(path);
    setPath("");
    setError(null);
  }
  const folder = active.split("/").slice(0, -1).join("/");
  function changeFolder(remove = false) {
    if (!folder) return;
    const destination = path.replace(/\/$/, "");
    if (!remove && !sourcePathSchema.safeParse(destination).success)
      return setError("Enter a valid destination folder.");
    const children = Object.keys(files).filter((file) =>
      file.startsWith(folder + "/"),
    );
    if (children.some((file) => protectedFiles.includes(file)))
      return setError("This folder contains a required file.");
    const next = { ...files };
    for (const file of children) delete next[file];
    if (!remove)
      for (const file of children) {
        const target = destination + file.slice(folder.length);
        if (Object.hasOwn(next, target))
          return setError("A destination file already exists.");
        next[target] = files[file]!;
      }
    const valid = workspaceFilesSchema.safeParse(next);
    if (!valid.success)
      return setError(
        valid.error.issues[0]?.message ?? "Invalid folder change.",
      );
    onChange(next);
    setSelected(remove ? "" : destination + active.slice(folder.length));
    setPath("");
    setFilter("");
    setError(null);
  }
  function sourceLink(href: string) {
    if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("//")) return null;
    try {
      return decodeURIComponent(
        new URL(href, "https://source.invalid/" + active).pathname.slice(1),
      );
    } catch {
      return null;
    }
  }
  function openSource(path: string) {
    setSelected(path);
    setFilter("");
    setMode(/\.md$/i.test(path) ? "preview" : "edit");
  }
  return (
    <section className={styles.repository} aria-label="Source repository">
      <aside className={styles.sidebar}>
        <Field label="Find a file">
          <TextInput
            type="search"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder="Filter files…"
          />
        </Field>
        <nav aria-label="Repository files" className={styles.tree}>
          <TreeRows
            tree={tree}
            selected={active}
            onSelect={setSelected}
            forceOpen={Boolean(filter)}
          />
          {!paths.length ? <p>No matching files.</p> : null}
        </nav>
        {!readOnly ? (
          <div className={styles.fileActions}>
            <Field label="File or folder path">
              <TextInput
                value={path}
                onChange={(event) => setPath(event.target.value)}
                placeholder="src/new-skill.py"
              />
            </Field>
            <div className={styles.row}>
              <Button size="sm" icon="plus" onClick={() => create()}>
                New file
              </Button>
              <Button size="sm" icon="folder" onClick={() => create(true)}>
                New folder
              </Button>
            </div>
            <div className={styles.row}>
              <Button
                size="sm"
                disabled={!active || protectedFiles.includes(active)}
                onClick={rename}
              >
                Rename / move
              </Button>
              <Button
                size="sm"
                disabled={!active || protectedFiles.includes(active)}
                onClick={() => {
                  const copy = { ...files };
                  delete copy[active];
                  onChange(copy);
                }}
              >
                Delete file
              </Button>
            </div>
            {folder ? (
              <>
                <p className={styles.muted}>Folder: {folder}</p>
                <div className={styles.row}>
                  <Button size="sm" onClick={() => changeFolder()}>
                    Rename folder
                  </Button>
                  <Button size="sm" onClick={() => changeFolder(true)}>
                    Remove folder
                  </Button>
                </div>
              </>
            ) : null}
          </div>
        ) : null}
      </aside>
      <div className={styles.filePanel}>
        <header className={styles.editorBar}>
          <code>{active || "No file selected"}</code>
          <div className={styles.row}>
            <Button
              size="sm"
              variant={mode === "edit" ? "primary" : "quiet"}
              onClick={() => setMode("edit")}
            >
              {readOnly ? "Source" : "Edit"}
            </Button>
            {/\.md$/i.test(active) ? (
              <Button
                size="sm"
                variant={mode === "preview" ? "primary" : "quiet"}
                onClick={() => setMode("preview")}
              >
                Preview
              </Button>
            ) : null}
            {baseFiles ? (
              <Button
                size="sm"
                variant={mode === "diff" ? "primary" : "quiet"}
                onClick={() => setMode("diff")}
              >
                Compare
              </Button>
            ) : null}
          </div>
        </header>
        {error ? <InlineMessage tone="error">{error}</InlineMessage> : null}
        {mode === "preview" && /\.md$/i.test(active) ? (
          <article className={styles.markdown}>
            <Markdown
              remarkPlugins={[remarkGfm]}
              components={{
                a: ({ href, children }) => {
                  const target = href ? sourceLink(href) : null;
                  if (target)
                    return Object.hasOwn(files, target) ? (
                      <button
                        type="button"
                        className={styles.sourceLink}
                        onClick={() => openSource(target)}
                      >
                        {children}
                      </button>
                    ) : (
                      <span title="This file is not in the source bundle">
                        {children}
                      </span>
                    );
                  return href && /^https?:|^mailto:/i.test(href) ? (
                    <a href={href} target="_blank" rel="noopener noreferrer">
                      {children}
                    </a>
                  ) : (
                    <span>{children}</span>
                  );
                },
                img: ({ src, alt }) => {
                  const target =
                    typeof src === "string" ? sourceLink(src) : null;
                  return target && Object.hasOwn(files, target) ? (
                    <button
                      type="button"
                      className={styles.sourceLink}
                      onClick={() => openSource(target)}
                    >
                      Open asset source: {alt || target}
                    </button>
                  ) : (
                    <span>{alt || "Image reference"}</span>
                  );
                },
              }}
            >
              {content}
            </Markdown>
          </article>
        ) : mode === "diff" && baseFiles ? (
          <div className={styles.diff}>
            <Field label="Saved source">
              <TextArea
                mono
                readOnly
                rows={24}
                value={baseFiles[active] ?? "(new file)"}
              />
            </Field>
            <Field label="Current source">
              <TextArea mono readOnly rows={24} value={content} />
            </Field>
          </div>
        ) : (
          <Field label={active || "Source"}>
            <TextArea
              className={styles.code}
              mono
              spellCheck={false}
              readOnly={readOnly || !active}
              value={content}
              onChange={(event) =>
                onChange({ ...files, [active]: event.target.value })
              }
            />
          </Field>
        )}
        <footer className={styles.editorBar}>
          <span>
            {Object.keys(files).length} files · {content.split("\n").length}{" "}
            lines
          </span>
          <span>
            {readOnly ? "Read only" : "Changes stay local until saved"}
          </span>
        </footer>
      </div>
    </section>
  );
}
