import { OPERATIONS, type OperationMeta } from "@ehf/ui-contracts";
import { Disclosure, Id } from "@ehf/ui-kit";
import { ConsoleHeader } from "@ehf/ui-shell";
import type { ComponentType } from "react";
import styles from "./shell.module.css";
import { StudioFrame } from "./studio-frame";

/**
 * Stand-in for a surface that has not been built yet. It says which milestone builds it and
 * lists the contract operations the surface will use (from `x-screens`), so the route,
 * guard and navigation can be exercised now without inventing data.
 */
export function placeholder(surfaceId: string, title: string, milestone: string, options: { console?: boolean } = {}): ComponentType {
  const operations = (OPERATIONS as readonly OperationMeta[]).filter((op) => op.xScreens.includes(surfaceId));
  function SurfacePlaceholder() {
    const body = (
      <section className={styles.placeholder} aria-label={`${surfaceId} ${title}`}>
        {options.console ? (
          <ConsoleHeader breadcrumb={[{ label: "Platform", href: "/platform" }, { label: surfaceId }]} title={title} />
        ) : (
          <header>
            <div className="t-engraved">{surfaceId}</div>
            <h1 className={styles.placeholderTitle}>{title}</h1>
          </header>
        )}
        <Disclosure tone="info" title="This workspace is not available yet">
          You can continue in the available workspaces from the main navigation. This view is still being prepared.
        </Disclosure>
        {operations.length ? (
          <>
            <details><summary>Technical details</summary><h2 className="t-engraved">Planned operations</h2>
            <ul className={styles.opList}>
              {operations.map((op) => (
                <li key={op.operationId}>
                  <Id>{op.operationId}</Id> <span className={styles.opMeta}>{op.method} {op.path}{op.xAction ? ` · ${op.xAction}` : ""}</span>
                </li>
              ))}
            </ul></details>
          </>
        ) : null}
      </section>
    );
    return options.console ? body : <StudioFrame>{body}</StudioFrame>;
  }
  SurfacePlaceholder.displayName = `Placeholder(${surfaceId})`;
  return SurfacePlaceholder;
}
