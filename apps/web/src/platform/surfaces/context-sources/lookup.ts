/** Preserve the projection and other equality filters; never rewrite advanced SQL. */
export function applyLookupFilter(
  query: string,
  column: string,
  parameter: string,
): string {
  const identifier = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
  if (!identifier.test(column) || !identifier.test(parameter))
    throw new Error("Choose a valid source column and parameter.");
  if (query.length > 16000) throw new Error("The read query is too long.");
  const parts = query.trim().split(/\bWHERE\b/i);
  const base = parts[0]!.trim();
  const words = base.split(/\s+/);
  const from = words.findIndex((word) => word.toLowerCase() === "from");
  const projection = words.slice(1, from).join(" ");
  if (
    parts.length > 2 ||
    words[0]?.toLowerCase() !== "select" ||
    from < 2 ||
    words.length !== from + 2 ||
    !/^[A-Za-z_][A-Za-z0-9_.]*$/.test(words[from + 1]!) ||
    (projection !== "*" &&
      !projection.split(",").every((name) => identifier.test(name.trim())))
  )
    throw new Error(
      "Use a simple scoped SELECT before applying visual lookup filters. Your query has been preserved.",
    );
  const filters =
    parts.length === 1
      ? []
      : parts[1]!
          .trim()
          .split(/\s+AND\s+/i)
          .map((clause) => {
            const match =
              /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*:([A-Za-z_][A-Za-z0-9_]*)$/.exec(
                clause,
              );
            if (!match)
              throw new Error(
                "Use equality filters joined by AND, or edit the read query directly. Your query has been preserved.",
              );
            return { column: match[1]!, parameter: match[2]! };
          });
  if (filters.filter((filter) => filter.parameter === parameter).length > 1)
    throw new Error(
      "This parameter filters several columns. Edit those filters in the read query.",
    );
  const existing = filters.find((filter) => filter.parameter === parameter);
  if (existing) existing.column = column;
  else filters.push({ column, parameter });
  return `${base} WHERE ${filters.map((filter) => `${filter.column} = :${filter.parameter}`).join(" AND ")}`;
}
