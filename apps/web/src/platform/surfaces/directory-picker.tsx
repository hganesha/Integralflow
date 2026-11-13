import type { Schemas } from "@ehf/ui-contracts";
import { Button, Field, Icon, TextInput } from "@ehf/ui-kit";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { api } from "../../app/api";
import { ApiErrorView } from "../common";
import styles from "./users.module.css";

export type DirectoryUser = Schemas["IdentityDirectoryUser"];

export function DirectoryPicker({ value, onChange, disabled }: { value: DirectoryUser | null; onChange: (person: DirectoryUser | null) => void; disabled: boolean }) {
  const [query, setQuery] = useState("");
  const term = query.trim();
  const [debounced, setDebounced] = useState("");
  useEffect(() => { const timer = setTimeout(() => setDebounced(term), 250); return () => clearTimeout(timer); }, [term]);
  const provider = useQuery({ queryKey: ["getAdminIdentityProvider"], queryFn: ({ signal }) => api.getAdminIdentityProvider({ signal }) });
  const search = useQuery({
    queryKey: ["getAdminIdentityProviderUsers", debounced],
    queryFn: ({ signal }) => api.getAdminIdentityProviderUsers({ query: { query: debounced }, signal }),
    enabled: Boolean(provider.data?.configured && !value && debounced.length >= 2 && debounced === term),
    retry: false,
  });
  if (provider.error) return <ApiErrorView error={provider.error} action={<Button size="sm" onClick={() => void provider.refetch()}>Retry connection</Button>} />;
  if (!provider.data) return <p className={styles.muted} role="status">Loading identity provider…</p>;
  if (!provider.data.configured) return <div className={styles.connectionNote}>
    <Icon name="link" /><div><strong>Connect your identity provider</strong><p>Configure Microsoft Entra ID in environment setup to find colleagues by name or email.</p>
      <a href="/onboarding">Open identity setup</a><Button size="sm" variant="quiet" onClick={() => void provider.refetch()}>Refresh connection</Button></div>
  </div>;
  if (value) return <section className={styles.directorySelection} aria-label="Selected directory user">
    <Icon name="user" /><div><strong>{value.displayName}</strong><span className={styles.email}>{value.email}</span><span className={styles.muted}>From {provider.data.label}</span></div>
    <Button size="sm" variant="quiet" disabled={disabled} onClick={() => { onChange(null); setQuery(""); }}>Change user</Button>
  </section>;
  const current = debounced === term;
  const results = current ? search.data : undefined;
  return <div className={styles.stack}>
    <Field label={`Search ${provider.data.label}`} hint="Search by name or email. Select a person to fill their details automatically.">
      <TextInput type="search" value={query} maxLength={100} autoComplete="off" disabled={disabled} onChange={event => setQuery(event.target.value)} />
    </Field>
    {term.length < 2 ? <p className={styles.muted}>Enter at least 2 characters to search your directory.</p> : !current || search.isFetching ? <p className={styles.muted} role="status">Searching your directory…</p> : null}
    {current && search.error ? <ApiErrorView error={search.error} action={<Button size="sm" onClick={() => void search.refetch()}>Retry search</Button>} /> : null}
    {results && !search.isFetching ? <>
      <p className={styles.muted} role="status">{results.items.length ? `${results.items.length} ${results.items.length === 1 ? "person" : "people"} found` : "No people found. Try another name or email."}</p>
      <ul className={styles.directoryResults} aria-label="Directory matches">{results.items.map(person => {
        const reason = person.alreadyAdded ? "Already added" : !person.enabled ? "Account disabled" : !person.email ? "Email unavailable" : null;
        return <li key={person.id}><button type="button" className={styles.directoryResult} disabled={disabled || reason !== null} aria-label={`Select ${person.displayName}${reason ? ` · ${reason}` : ""}`} onClick={() => onChange(person)}>
          <Icon name="user" /><span><strong>{person.displayName}</strong><span className={styles.email}>{person.email ?? person.principalName}</span></span><span className={styles.muted}>{reason ?? "Select"}</span>
        </button></li>;
      })}</ul>
      {results.hasMore ? <p className={styles.muted}>Showing the first 25 matches. Refine your search to find the right person.</p> : null}
    </> : null}
  </div>;
}
