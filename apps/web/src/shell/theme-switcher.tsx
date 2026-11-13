import { Button, type IconName } from "@ehf/ui-kit";
import { useEffect, useState } from "react";

const STORAGE_KEY = "integralflow.theme";
const MODES = ["system", "light", "dark"] as const;
type Theme = typeof MODES[number];
const ICONS: Record<Theme, IconName> = { system: "monitor", light: "sun", dark: "moon" };
const LABELS: Record<Theme, string> = { system: "System", light: "Light", dark: "Dark" };
function theme(value: string | null | undefined): Theme {
  return MODES.includes(value as Theme) ? value as Theme : "system";
}

/** One control cycles all three preferences. System follows OS changes through CSS. */
export function ThemeSwitcher() {
  const [mode, setMode] = useState(() => theme(document.documentElement.dataset.theme));
  const next = MODES[(MODES.indexOf(mode) + 1) % MODES.length]!;
  useEffect(() => {
    const sync = (event: StorageEvent) => {
      if (event.key !== STORAGE_KEY && event.key !== null) return;
      const value = theme(event.newValue);
      document.documentElement.dataset.theme = value;
      setMode(value);
    };
    window.addEventListener("storage", sync);
    return () => window.removeEventListener("storage", sync);
  }, []);
  const label = `Theme: ${LABELS[mode]}. Switch to ${LABELS[next].toLowerCase()} mode`;
  return <Button size="sm" variant="quiet" icon={ICONS[mode]} aria-label={label} title={label} onClick={() => {
    document.documentElement.dataset.theme = next;
    setMode(next);
    try { localStorage.setItem(STORAGE_KEY, next); } catch { /* The preference still applies when storage is unavailable. */ }
  }} />;
}
