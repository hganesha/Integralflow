export type FileChanges = {
  changed: Record<string, string>;
  deleted: string[];
};
export function changesBetween(
  base: Record<string, string>,
  files: Record<string, string>,
): FileChanges {
  return {
    changed: Object.fromEntries(
      Object.entries(files).filter(([path, text]) => base[path] !== text),
    ),
    deleted: Object.keys(base).filter((path) => !Object.hasOwn(files, path)),
  };
}
export function applyChanges(
  base: Record<string, string>,
  changes: FileChanges,
) {
  const result = { ...base, ...changes.changed };
  for (const path of changes.deleted) delete result[path];
  return result;
}
