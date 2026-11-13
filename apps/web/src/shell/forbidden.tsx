import { Disclosure, EmptyState } from "@ehf/ui-kit";
import { Link } from "@tanstack/react-router";
import styles from "./shell.module.css";

/**
 * 403 surface (§8.3 guards). Never a silent redirect. The contract does not tell the browser
 * which roles grant an action (GAP-020), so this names the missing actions instead.
 */
export function Forbidden({ title, requires, authoringDisabled = false }: { title: string; requires: readonly string[]; authoringDisabled?: boolean }) {
  return (
    <div className={styles.centered}>
      <EmptyState icon="lock" headingLevel={1} title={authoringDisabled ? "Authoring is disabled in this environment" : `${title} is not available to you`}>
        {authoringDisabled
          ? "Drafts and Policy Studio are switched off here. Published plans and runs are still available."
          : <>It needs one of these permissions: <code>{requires.join(", ")}</code>. Ask an administrator for a role that grants it.</>}
      </EmptyState>
      {!authoringDisabled ? (
        <Disclosure tone="info" title="Why we name permissions, not roles">
          The session lists what you can do, not which roles grant each permission.
        </Disclosure>
      ) : null}
      <Link to="/">Go to your start page</Link>
    </div>
  );
}
