import { Icon, StatusBadge } from "@ehf/ui-kit";
import { useRef, type KeyboardEvent } from "react";
import { bankLabel, moveInGrid, STATUS_WORDS, type BankReading, type BayDef, type GridPos } from "./model";
import styles from "./context.module.css";

/**
 * Twelve InstrumentBanks in three fixed bays (CXT-01). One tab stop for the whole grid
 * (roving tabindex); arrows move between banks and bays; Enter/Space selects. Status is in
 * words with field counts; never a percentage (AC2).
 */
export function InstrumentBanks({ bays, readings, selected, onSelect }: {
  bays: readonly BayDef[];
  readings: ReadonlyMap<string, BankReading>;
  selected: string | undefined;
  onSelect: (productId: string) => void;
}) {
  const refs = useRef(new Map<string, HTMLButtonElement>());
  const positions = bays.flatMap((bay, b) => bay.banks.map((bank, k) => ({ productId: bank.productId, pos: { bay: b, bank: k } as GridPos })));
  const tabStop = positions.find((entry) => entry.productId === selected)?.productId ?? positions[0]?.productId;

  const onKeyDown = (event: KeyboardEvent, pos: GridPos) => {
    const next = moveInGrid(bays, pos, event.key);
    if (!next) return;
    event.preventDefault();
    const productId = bays[next.bay]?.banks[next.bank]?.productId;
    if (productId) refs.current.get(productId)?.focus();
  };

  return (
    <div className={styles.bays} role="group" aria-label="Intelligence banks">
      {bays.map((bay, b) => (
        <section key={bay.id} className={styles.bay} aria-labelledby={`bay-${bay.id}`}>
          <h2 id={`bay-${bay.id}`} className={styles.bayLabel}>{bay.name}</h2>
          <div className={styles.bayGrid}>
            {bay.banks.map((bank, k) => {
              const reading = readings.get(bank.productId);
              if (!reading) return null;
              return (
                <button
                  key={bank.productId}
                  ref={(element) => { if (element) refs.current.set(bank.productId, element); else refs.current.delete(bank.productId); }}
                  type="button"
                  className={styles.bank}
                  data-bank={bank.productId}
                  data-status={reading.status}
                  aria-pressed={bank.productId === selected}
                  aria-label={bankLabel(bank.name, reading)}
                  tabIndex={bank.productId === tabStop ? 0 : -1}
                  onClick={() => onSelect(bank.productId)}
                  onKeyDown={(event) => onKeyDown(event, { bay: b, bank: k })}
                >
                  <span className={styles.bankTop} aria-hidden="true">
                    <Icon name={bank.icon} />
                    <StatusBadge dimension="ContextReadiness" value={reading.status} label={STATUS_WORDS[reading.status]} />
                  </span>
                  <span className={styles.bankName} aria-hidden="true">{bank.name}</span>
                  <span className={styles.bankSummary} aria-hidden="true">{reading.summary}</span>
                  <span className={styles.bankCounts} aria-hidden="true">
                    {reading.counts.map((count) => <span key={count.label}><b>{count.value}</b> {count.label}</span>)}
                  </span>
                </button>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}

/** Legend in words: the four readiness states the banks can show. */
export function ReadinessLegend() {
  return (
    <ul className={styles.legend} aria-label="Access coverage legend">
      {(Object.keys(STATUS_WORDS) as Array<keyof typeof STATUS_WORDS>).map((status) => (
        <li key={status}><StatusBadge dimension="ContextReadiness" value={status} label={STATUS_WORDS[status]} /></li>
      ))}
    </ul>
  );
}
