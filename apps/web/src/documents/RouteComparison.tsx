import type { Schemas } from "@ehf/ui-contracts";
import { SegmentedControl, Table, ToneBadge, type Column } from "@ehf/ui-kit";
import { useState } from "react";
import { OUTCOMES, REVIEW_LABELS, ROUTE_STATUS, fieldLabel, outcomeSummary, routeOrder, visibleFields } from "./route-comparison-model";
import styles from "./studio.module.css";

type Comparison = Schemas["DocumentRouteComparison"];
type Field = Schemas["DocumentRouteField"];

/**
 * The Test Bench's side-by-side route view (document factory plan Phase 2): how each extraction route read
 * each field, and the deterministic outcome. The proposed route's values are the ones extracted; the other
 * route ran in shadow, and its disagreements only add review.
 */
export function RouteComparison({ comparison, selected, onSelect }: { comparison: Comparison; selected: string | null; onSelect: (assertionId: string) => void }) {
  const [filter, setFilter] = useState<"review" | "all">("review");
  const routes = routeOrder(comparison);
  const labels = new Map(comparison.routes.map(route => [route.route, route.label]));
  const fields = visibleFields(comparison, filter);
  const review = comparison.fields.filter(field => field.review === "required").length;
  const reading = (field: Field, route: string) => {
    const candidate = field.candidates.find(item => item.route === route);
    if (!candidate || candidate.value === null) return <span className={styles.absent}>No value</span>;
    const chosen = field.selectedRoute === route;
    return <div className={styles.reading} data-chosen={chosen || undefined}>
      <span className={styles.value}>{candidate.value}</span>
      <span className={styles.meta}>{candidate.grounded ? "Cited on page" : "Not cited"}{candidate.confidence !== null ? ` · confidence ${Math.round(candidate.confidence * 100)}%` : ""}{chosen ? " · selected" : ""}</span>
    </div>;
  };
  const columns: Column<Field>[] = [
    { key: "field", header: "Field", render: field => <div className={styles.fieldCell}>
      {field.assertionId
        ? <button type="button" className={styles.fieldLink} aria-pressed={selected === field.assertionId} onClick={() => onSelect(field.assertionId!)}>{fieldLabel(field.path)}</button>
        : <span>{fieldLabel(field.path)}</span>}
      <span className={styles.meta}>{[field.keyField ? "Key field" : null, field.criticality].filter(Boolean).join(" · ")}</span>
    </div> },
    ...routes.map(route => ({ key: `route-${route}`, header: route === comparison.proposedRoute ? `${labels.get(route)} (proposed)` : `${labels.get(route)} (shadow)`, render: (field: Field) => reading(field, route) })),
    { key: "outcome", header: "Outcome", render: field => <div className={styles.fieldCell} title={OUTCOMES[field.outcome].detail}>
      <ToneBadge tone={OUTCOMES[field.outcome].tone} icon={OUTCOMES[field.outcome].icon}>{OUTCOMES[field.outcome].label}</ToneBadge>
      <span className={styles.meta}>Rule {field.rule}</span>
    </div> },
    { key: "review", header: "Review", render: field => <span>{REVIEW_LABELS[field.review]}</span> },
  ];
  return <section className={styles.routes} aria-labelledby="route-comparison-heading">
    <div className={styles.resultHeader}>
      <div>
        <h3 id="route-comparison-heading">Extraction routes</h3>
        <p>The proposed values come from the {labels.get(comparison.proposedRoute)}. The other route ran in shadow: where the routes disagree, the field needs review. Nothing here verifies or accepts a value.</p>
      </div>
      <ToneBadge tone={comparison.reviewRequired ? "attention" : "neutral"} icon={comparison.reviewRequired ? "alert" : "check"}>{review ? `${review} field${review === 1 ? "" : "s"} need review` : "No field needs review"}</ToneBadge>
    </div>
    <ul className={styles.routeList} aria-label="Routes">
      {routes.map(id => {
        const route = comparison.routes.find(item => item.route === id)!;
        const status = ROUTE_STATUS[route.status];
        return <li key={id} className={styles.routeCard}>
          <strong>{route.label}{id === comparison.proposedRoute ? " · proposed" : " · shadow"}</strong>
          <span className={styles.meta}>{[route.provider, route.model].filter(Boolean).join(" · ") || "Provider not reported"}</span>
          <ToneBadge tone={status.tone} icon={status.icon}>{status.label}</ToneBadge>
          {route.error ? <code className={styles.meta}>{route.error}</code> : null}
          {route.issues.length ? <span className={styles.meta}>Issues: {route.issues.join(", ")}</span> : null}
        </li>;
      })}
    </ul>
    <p className={styles.meta}>{outcomeSummary(comparison).map(item => `${item.label}: ${item.count}`).join(" · ")} · Policy {comparison.policy.id} {comparison.policy.version}</p>
    <SegmentedControl label="Fields shown" value={filter} onChange={setFilter} options={[{ value: "review", label: `Needs review (${review})` }, { value: "all", label: `All fields (${comparison.fields.length})` }]} />
    <Table caption="Field readings by route" captionHidden rows={fields} rowKey={field => field.path} columns={columns} stickyFirstColumn
      empty={<p className={styles.meta}>No field needs review. Switch to all fields to see every reading.</p>} />
  </section>;
}
