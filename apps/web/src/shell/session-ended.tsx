import { Button, Sheet } from "@ehf/ui-kit";
import { useRouterState } from "@tanstack/react-router";
import { useState } from "react";
import brandWordmark from "../../icons/brand-wordmark.png";
import styles from "./shell.module.css";
import { signIn } from "../app/auth";
import { useSessionEnded } from "../app/session-events";

/**
 * Shown after any 401 (§9.1, Shell AC5). Unsaved input stays in memory; signing in returns
 * to the same route.
 */
export function SessionEndedDialog({ onSignedIn }: { onSignedIn: () => void }) {
  const ended = useSessionEnded();
  const href = useRouterState({ select: (state) => state.location.href });
  const [busy, setBusy] = useState(false);
  return (
    <Sheet
      open={ended}
      onClose={() => undefined}
      title="Your session ended"
      description="Sign in again to continue. Anything you were typing is kept on this page."
      footer={(
        <Button variant="primary" busy={busy} onClick={async () => {
          setBusy(true);
          try {
            await signIn(href);
            onSignedIn();
          } finally {
            setBusy(false);
          }
        }}>
          Sign in again
        </Button>
      )}
    >
      <img className={styles.brandWordmark} src={brandWordmark} alt="IntegralFlow" width={240} height={120} />
      <p>For your security, actions are paused until you sign in.</p>
    </Sheet>
  );
}
