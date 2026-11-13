import { ApiError } from "@ehf/ui-client";
import { Button, ErrorDetail, InlineMessage, Skeleton } from "@ehf/ui-kit";
import { useQueryClient } from "@tanstack/react-query";
import { Outlet } from "@tanstack/react-router";
import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { api } from "../app/api";
import { SessionProvider, useSessionQuery } from "../app/session";
import { markSessionEnded } from "../app/session-events";
import { Chrome, type Experience } from "./chrome";
import { NotFound } from "./not-found";
import { SearchPalette } from "./search";
import { SessionEndedDialog } from "./session-ended";
import styles from "./shell.module.css";

const SearchContext = createContext<() => void>(() => undefined);

/** Session gate, chrome, search and the session-ended dialog around every route. */
export function AppRoot({ experiences }: { experiences: readonly Experience[] }) {
  const session = useSessionQuery();
  const queryClient = useQueryClient();
  const [searchOpen, setSearchOpen] = useState(false);
  const [signOutError, setSignOutError] = useState<string | null>(null);
  const openSearch = useCallback(() => setSearchOpen(true), []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setSearchOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const refetchAll = () => void queryClient.invalidateQueries();
  const dialog = <SessionEndedDialog onSignedIn={refetchAll} />;

  if (session.isPending) return <><Skeleton height="100vh" label="Loading your session" />{dialog}</>;
  if (session.error && !session.data) {
    const error = session.error;
    if (error instanceof ApiError && error.status === 401) return dialog;
    return (
      <div className={styles.centered}>
        <ErrorDetail
          title="IntegralFlow could not load your session"
          error={error instanceof ApiError ? { error: error.reason, message: error.message, ...(error.correlationId ? { correlationId: error.correlationId } : {}), ...(error.body.details ? { details: error.body.details } : {}) } : { error: "web.unexpected", message: String(error) }}
          action={<Button onClick={() => void session.refetch()}>Retry</Button>}
        />
        {dialog}
      </div>
    );
  }

  return (
    <SessionProvider session={session.data!}>
      <SearchContext.Provider value={openSearch}>
        <a className={styles.skip} href="#main">Skip to main content</a>
        <Chrome
          experiences={experiences}
          onOpenSearch={openSearch}
          onSignOut={async () => {
            setSignOutError(null);
            try {
              await api.postAuthLogout();
              queryClient.clear();
              markSessionEnded(true);
            } catch {
              setSignOutError('Sign out could not be confirmed. Try again from your account menu.');
            }
          }}
        />
        <main id="main" tabIndex={-1} className={styles.surface}>
          {signOutError ? <InlineMessage tone="error">{signOutError}</InlineMessage> : null}
          <Outlet />
        </main>
        <SearchPalette open={searchOpen} onClose={() => setSearchOpen(false)} />
        {dialog}
      </SearchContext.Provider>
    </SessionProvider>
  );
}

export function RootNotFound() {
  const openSearch = useContext(SearchContext);
  return <NotFound onOpenSearch={openSearch} />;
}
