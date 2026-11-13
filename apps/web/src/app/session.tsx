import type { Schemas } from "@ehf/ui-contracts";
import { useQuery } from "@tanstack/react-query";
import { createContext, useContext, type ReactNode } from "react";
import { api, setCsrfToken } from "./api";
import { markSessionEnded } from "./session-events";

export type Session = Schemas["Session"];

const SessionContext = createContext<Session | null>(null);

export function useSessionQuery() {
  return useQuery({
    queryKey: ["session"],
    queryFn: async () => {
      const session = await api.getSession();
      setCsrfToken(session.csrfToken);
      markSessionEnded(false);
      return session;
    },
    staleTime: 30_000,
  });
}

export function SessionProvider({ session, children }: { session: Session; children: ReactNode }) {
  return <SessionContext.Provider value={session}>{children}</SessionContext.Provider>;
}

/** The current session. Only rendered below the session gate, so it is always present. */
export function useSession(): Session {
  const session = useContext(SessionContext);
  if (!session) throw new Error("useSession outside SessionProvider");
  return session;
}
