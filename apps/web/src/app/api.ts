import { createExperienceClient } from "@ehf/ui-client";

let csrfToken: string | null = null;

/** Updated whenever the session is (re)fetched; every mutation sends it (§4.3). */
export function setCsrfToken(token: string | null): void {
  csrfToken = token;
}

/** The app's single client. Components reach data only through it (N1). */
export const api = createExperienceClient({ baseUrl: "/api", getCsrf: () => csrfToken });
