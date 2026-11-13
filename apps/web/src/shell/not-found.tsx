import { Button, EmptyState } from "@ehf/ui-kit";
import { Link } from "@tanstack/react-router";
import styles from "./shell.module.css";

/** 404 with search (§8.3 `*`). */
export function NotFound({ onOpenSearch }: { onOpenSearch: () => void }) {
  return (
    <div className={styles.centered}>
      <EmptyState icon="search" headingLevel={1} title="Page not found" action={<Button icon="search" onClick={onOpenSearch}>Search</Button>}>
        The address may be mistyped, or the record may no longer exist.
      </EmptyState>
      <Link to="/">Go to your start page</Link>
    </div>
  );
}
