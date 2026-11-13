import type { DomainModule } from "@ehf/ui-shell";
import { fincrimeModule } from "./domains/fincrime/module";

/**
 * Registered domain modules (§8.5). This composition root is the only place that knows about
 * domains; the shell and platform console stay domain-neutral (N13).
 */
export const MODULES: readonly DomainModule[] = [fincrimeModule];
