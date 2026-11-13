import { Field, JsonViewer, Select } from "@ehf/ui-kit";
import { useState } from "react";
import { stringify } from "yaml";
import styles from "./sandbox.module.css";

export function InspectorChoice({ label, value, items, onChange }: {
  label: string;
  value: string;
  items: ReadonlyArray<{ value: string; label: string }>;
  onChange: (value: string) => void;
}) {
  return <Field label={label}><Select value={value} onChange={event => onChange(event.target.value)}>
    {items.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}
  </Select></Field>;
}

export function AdvancedData({ label, data }: { label: string; data: unknown }) {
  const [open, setOpen] = useState(false);
  return <details className={styles.advanced} onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>Advanced · {label}</summary>
    {open ? <JsonViewer label={`${label} YAML`} data={stringify(data)} maxHeight={240} /> : null}
  </details>;
}
