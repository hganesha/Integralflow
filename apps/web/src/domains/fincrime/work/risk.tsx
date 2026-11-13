import type { Schemas } from "@ehf/ui-contracts";
import { Id } from "@ehf/ui-kit";
import { percent } from "./ownership-graph";
import styles from "./work.module.css";

type Risk = NonNullable<Schemas["DecisionDesk"]["risk"]>;

/**
 * Risk attribution as bars sized by each factor's `share` (BIZ-07-AC6), with the exact share
 * and contribution as text beside them. The bar length is the only graphic encoding.
 */
export function RiskAttribution({ risk, headingLevel = 3 }: { risk: Risk; headingLevel?: 2 | 3 }) {
  const Heading = headingLevel === 2 ? "h2" : "h3";
  return (
    <section aria-labelledby="risk-title" className={styles.section}>
      <Heading id="risk-title" className={styles.subTitle}>Risk attribution</Heading>
      <p className={styles.meta}>
        <span>Tier <strong>{risk.tier}</strong></span>
        <span>Score <span className="num">{risk.score}</span></span>
        <span>Model <Id>{risk.modelVersion}</Id></span>
      </p>
      <ul className={styles.bars} aria-label="Factor shares">
        {risk.contributions.map((factor) => (
          <li key={factor.factor} className={styles.bar} data-factor={factor.factor} data-share={factor.share}>
            <span>{factor.factor}</span>
            <span className={styles.barTrack} aria-hidden="true"><span className={styles.barFill} style={{ display: "block", width: percent(factor.share) }} /></span>
            <span className="num">{percent(factor.share)} of score · +{factor.contribution}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
