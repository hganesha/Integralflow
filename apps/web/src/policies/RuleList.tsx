import { Button, EmptyState, Id } from "@ehf/ui-kit";
import type { Clause, Rulebook } from "./rulebook";
import styles from "./studio.module.css";

function ClauseView({ clause }: { clause: Clause }) {
  return (
    <>
      <span>{clause.text}</span>
      {clause.children.length ? (
        <ul className={styles.clauses}>
          {clause.children.map((child, index) => <li key={index}><ClauseView clause={child} /></li>)}
        </ul>
      ) : null}
    </>
  );
}

/** Every gate or decision table as an ordered list of "when … then …" rules. */
export function RuleList({ book, onOpenSource }: { book: Rulebook; onOpenSource?: (path: string) => void }) {
  if (!book.sections.length) {
    return <EmptyState icon="file" title="No rules in this policy yet" headingLevel={3}>Rules appear here once the policy source declares gates or decision tables.</EmptyState>;
  }
  return (
    <div className={styles.sections}>
      {book.errors.map((error) => <p role="alert" key={error.path}><Id>{error.path}</Id>: {error.message}</p>)}
      {book.sections.map((section) => (
        <section key={`${section.path}#${section.id}`} className={styles.section} aria-labelledby={`rules-${section.id}`}>
          <div className={styles.sectionHead}>
            <h3 id={`rules-${section.id}`}>{section.title}</h3>
            <span className={styles.hint}>{section.rules.length} rule{section.rules.length === 1 ? "" : "s"}</span>
          </div>
          {section.description ? <p className={styles.hint}>{section.description}</p> : null}
          <p className={styles.hint}>{section.order}</p>
          <ol className={styles.rules} aria-label={`${section.title} rules`}>
            {section.rules.map((rule, index) => (
              <li key={rule.id} className={styles.rule}>
                <span className={styles.ruleIndex}>{index + 1}</span>
                <div className={styles.ruleWhen}><span>When</span><ClauseView clause={rule.when} /></div>
                <div className={styles.ruleThen}>
                  <strong>{rule.then}</strong>
                  {rule.reasonCodes.length ? <span className={styles.codes}>{rule.reasonCodes.join(", ")}</span> : null}
                  <span className={styles.ruleId}>{rule.id}</span>
                </div>
              </li>
            ))}
            {section.otherwise ? (
              <li className={styles.rule} data-otherwise="">
                <span className={styles.ruleIndex}>—</span>
                <div className={styles.ruleWhen}><span>Otherwise</span><span>No rule above matched.</span></div>
                <div className={styles.ruleThen}>
                  <strong>{section.otherwise.then}</strong>
                  {section.otherwise.reasonCodes.length ? <span className={styles.codes}>{section.otherwise.reasonCodes.join(", ")}</span> : null}
                </div>
              </li>
            ) : null}
          </ol>
          {onOpenSource ? <div><Button size="sm" variant="quiet" icon="file" onClick={() => onOpenSource(section.path)}>Open source</Button></div> : null}
        </section>
      ))}
    </div>
  );
}
