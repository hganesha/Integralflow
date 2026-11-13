import { useState, type ReactNode } from "react";
import { InspectorChoice } from "./InspectorControls";
import styles from "./sandbox.module.css";

type HistoryFilter<Row> = {
  key: string;
  label: string;
  value: (row: Row) => string;
  format?: (value: string) => string;
};

export function SandboxHistoryFilters<Row>({ rows, filters, children }: {
  rows: readonly Row[];
  filters: readonly HistoryFilter<Row>[];
  children: (filtered: Row[]) => ReactNode;
}) {
  const [selected, setSelected] = useState<Record<string, string>>({});
  const filtered = rows.filter(row => filters.every(filter => !selected[filter.key] || selected[filter.key] === filter.value(row)));
  return <div className={styles.inspectorStack}>
    <details className={styles.historyFilters}>
      <summary>Filter history</summary>
      <div className={styles.row}>
        {filters.map(({ key, label, value, format }) => {
          const selection = selected[key] ?? "";
          const options = [...new Set(rows.map(value).concat(selection))].filter(Boolean).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
          return <InspectorChoice key={key} label={label} value={selection}
            onChange={next => setSelected(prior => ({ ...prior, [key]: next }))}
            items={[{ value: "", label: "Any" }, ...options.map(option => ({ value: option, label: format?.(option) ?? option }))]} />;
        })}
      </div>
    </details>
    {filtered.length ? children(filtered) : <p>No runs match these filters.</p>}
  </div>;
}
