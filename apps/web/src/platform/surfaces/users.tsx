import type { Schemas } from "@ehf/ui-contracts";
import { usePolled } from "@ehf/ui-client/react";
import { Button, EmptyState, Field, Icon, InlineMessage, LocalTimestamp, Select, Sheet, Table, Tabs, TextInput, ToneBadge } from "@ehf/ui-kit";
import { ConsoleHeader } from "@ehf/ui-shell";
import { useId, useState, type FormEvent } from "react";
import { api } from "../../app/api";
import { useSession } from "../../app/session";
import { ApiErrorView, Freshness, Region, useCommand, useSearchParam } from "../common";
import styles from "./users.module.css";
import { DirectoryPicker, type DirectoryUser } from "./directory-picker";

type User = Schemas["PlatformUser"];
type Role = Schemas["PlatformRole"];
type Tab = "users" | "roles";
const INVALIDATE = [["getAdminUsers"], ["getAdminIdentityProviderUsers"], ["session"]] as const;
const initials = (name: string) => name.trim().split(/\s+/).slice(0, 2).map(part => part[0]).join("").toUpperCase();

export default function Users() {
  const session = useSession();
  const users = usePolled(api, "getAdminUsers");
  const roles = usePolled(api, "getAdminRoles");
  const [tabParam, setTab] = useSearchParam("tab");
  const [query, setQuery] = useState("");
  const [roleFilter, setRoleFilter] = useState("");
  const [editor, setEditor] = useState<User | "new" | null>(null);
  const [notice, setNotice] = useState("");
  const canWrite = session.actions.includes("admin.write");
  const tab: Tab = tabParam === "roles" ? "roles" : "users";
  const catalogue = roles.data?.items ?? [];
  const allUsers = users.data?.items ?? [];
  const roleName = (id: string) => catalogue.find(role => role.id === id)?.name ?? id;
  const filtered = allUsers.filter(user => (!roleFilter || user.roles.includes(roleFilter)) && `${user.displayName} ${user.email} ${user.subjectId}`.toLowerCase().includes(query.trim().toLowerCase()));

  return <div className={styles.page}>
    <ConsoleHeader breadcrumb={[{ label: "Platform", href: "/platform" }, { label: "Users & roles" }]} title="Users & roles"
      meta={<span>Manage who can access your workspace and what they can do.</span>}
      actions={<Button variant="primary" icon="plus" disabled={!canWrite || !roles.data} onClick={() => { setNotice(""); setEditor("new"); }}>Add user</Button>} />
    {!canWrite ? <p className={styles.muted} role="status">You have read-only access. Requires Platform.Admin to add users or change roles.</p> : null}
    {notice ? <InlineMessage tone="ok">{notice}</InlineMessage> : null}
    <section className={styles.summary} aria-label="Access overview">
      <div><span className={styles.summaryIcon}><Icon name="users" /></span><div><span className={styles.summaryValue}>{users.data ? allUsers.length : "…"}</span><span className={styles.muted}>Workspace users</span></div></div>
      <div><span className={styles.summaryIcon}><Icon name="shield" /></span><div><span className={styles.summaryValue}>{roles.data ? catalogue.length : "…"}</span><span className={styles.muted}>Available roles</span></div></div>
      <div><span className={styles.summaryIcon}><Icon name="lock" /></span><div><span className={styles.summaryValue}>{users.data ? allUsers.filter(user => user.roles.includes("Platform.Admin")).length : "…"}</span><span className={styles.muted}>Administrators</span></div></div>
    </section>
    <Tabs<Tab> label="User management sections" value={tab} onChange={value => setTab(value === "users" ? undefined : value)}
      items={[{ value: "users", label: "Users", ...(users.data ? { count: allUsers.length } : {}) }, { value: "roles", label: "Roles & permissions", ...(roles.data ? { count: catalogue.length } : {}) }]}
      renderPanel={value => value === "users" ? <div className={styles.stack}>
        <form className={styles.toolbar} role="search" aria-label="Filter users" onSubmit={event => event.preventDefault()}>
          <div className={styles.search}><Field label="Search users"><TextInput type="search" placeholder="Search by name or email" value={query} onChange={event => setQuery(event.target.value)} /></Field></div>
          <Field label="Role"><Select value={roleFilter} onChange={event => setRoleFilter(event.target.value)}><option value="">All roles</option>{catalogue.map(role => <option key={role.id} value={role.id}>{role.name}</option>)}</Select></Field>
          <Freshness polled={users} />
        </form>
        {roles.error ? <ApiErrorView error={roles.error} action={<Button size="sm" onClick={roles.refresh}>Retry roles</Button>} /> : null}
        <Region polled={users} label="users">{() => <>
          <p className={styles.muted} role="status">{filtered.length} of {allUsers.length} users</p>
          <Table<User> caption="Workspace users" captionHidden rows={filtered} rowKey={user => user.userId}
            empty={<EmptyState icon="users" title={allUsers.length ? "No users match your filters" : "Add your first user"} headingLevel={3}
              action={allUsers.length ? <Button variant="quiet" onClick={() => { setQuery(""); setRoleFilter(""); }}>Clear filters</Button> : undefined}>
              {allUsers.length ? "Try another name, email or role." : "Add a colleague and choose the roles they need to get started."}
            </EmptyState>}
            columns={[
              { key: "name", header: "User", render: user => <div className={styles.person}><span className={styles.avatar} aria-hidden="true">{initials(user.displayName)}</span><div><strong>{user.displayName}</strong>{[session.subject.subjectId, session.subject.directorySubjectId].includes(user.subjectId) ? <span className={styles.you}>You</span> : null}<span className={styles.email}>{user.email}</span></div></div> },
              { key: "roles", header: "Assigned roles", render: user => <div className={styles.roleTags}>{user.roles.map(id => <ToneBadge key={id} tone={id === "Platform.Admin" ? "info" : "neutral"} icon={id === "Platform.Admin" ? "shield" : "user"}>{roleName(id)}</ToneBadge>)}</div> },
              { key: "updated", header: "Last updated", render: user => <LocalTimestamp iso={user.updatedAt} compact /> },
              { key: "actions", header: "Actions", align: "end", render: user => <Button size="sm" variant="quiet" disabled={!canWrite || !roles.data} aria-label={`Manage ${user.displayName}`} onClick={() => { setNotice(""); setEditor(user); }}>Manage</Button> },
            ]} />
        </>}</Region>
      </div> : <Region polled={roles} label="roles">{() => <RoleCatalogue roles={catalogue} users={allUsers} countsAvailable={Boolean(users.data)} />}</Region>} />
    {editor && roles.data ? <UserEditor key={editor === "new" ? "new" : `${editor.userId}:${editor.revision}`} user={editor === "new" ? null : editor} roles={catalogue}
      onClose={() => setEditor(null)} onSaved={user => { setEditor(null); setNotice(`${user.displayName} ${editor === "new" ? "added" : "updated"}. Assigned roles are now saved.`); }} /> : null}
  </div>;
}

function RoleCatalogue({ roles, users, countsAvailable }: { roles: readonly Role[]; users: readonly User[]; countsAvailable: boolean }) {
  return <div className={styles.stack}>
    <p className={styles.muted}>Assign one or more roles to each user. Their permissions combine across all assigned roles.</p>
    <div className={styles.roleGrid}>{roles.map(role => <section key={role.id} className={styles.roleCard} aria-label={role.name}>
      <div className={styles.roleHeading}><Icon name="shield" /><h2>{role.name}</h2><span className={styles.muted}>{countsAvailable ? users.filter(user => user.roles.includes(role.id)).length : "…"} users</span></div>
      <p>{role.description}</p>
      <details><summary>{role.actions.length} permissions</summary><ul className={styles.permissions}>{role.actions.map(action => <li key={action}><code>{action}</code></li>)}</ul></details>
    </section>)}</div>
  </div>;
}

function UserEditor({ user, roles, onClose, onSaved }: { user: User | null; roles: readonly Role[]; onClose: () => void; onSaved: (user: User) => void }) {
  const session = useSession();
  const formId = useId();
  const [displayName, setName] = useState(user?.displayName ?? "");
  const [email, setEmail] = useState(user?.email ?? "");
  const [directoryPerson, setDirectoryPerson] = useState<DirectoryUser | null>(null);
  const [selected, setSelected] = useState<readonly string[]>(user?.roles ?? []);
  const [reason, setReason] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const create = useCommand("postAdminUsers", { invalidate: INVALIDATE });
  const update = useCommand("putAdminUsersUserId", { invalidate: INVALIDATE });
  const command = user ? update : create;
  const ownAdmin = Boolean(user && [session.subject.subjectId, session.subject.directorySubjectId].includes(user.subjectId));
  const actions = [...new Set(roles.filter(role => selected.includes(role.id)).flatMap(role => role.actions))].sort();
  const close = () => { if (!command.busy) onClose(); };
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setSubmitted(true);
    if (!selected.length || command.busy || !user && !directoryPerson) return;
    const body = { displayName: displayName.trim(), email: email.trim(), roles: [...selected], reason: reason.trim() };
    const result = user ? await update.run({ path: { userId: user.userId }, body: { ...body, expectedRevision: user.revision } }) : await create.run({ body: { directoryUserId: directoryPerson!.id, roles: [...selected], reason: reason.trim() } });
    if (result) onSaved(result);
  };
  return <Sheet open onClose={close} title={user ? "Manage user" : "Add user"} description={user ? "Update this user's details and assigned roles." : "Find a colleague in your identity provider and choose their roles."}
    footer={<><Button variant="quiet" disabled={command.busy} onClick={close}>Cancel</Button><Button type="submit" form={formId} variant="primary" busy={command.busy} disabled={!user && !directoryPerson}>{user ? "Save changes" : "Add user"}</Button></>}>
    <form id={formId} className={styles.editor} onSubmit={event => void submit(event)}>
      <fieldset disabled={command.busy} className={styles.fields}>
        {!user ? <DirectoryPicker value={directoryPerson} onChange={setDirectoryPerson} disabled={command.busy} /> : null}
        {user || directoryPerson ? <>
          <Field label="Full name"><TextInput required readOnly={!user} maxLength={160} autoComplete="name" value={user ? displayName : directoryPerson!.displayName} onChange={event => setName(event.target.value)} /></Field>
          <Field label="Email address"><TextInput required readOnly={!user} type="email" maxLength={254} autoComplete="email" value={user ? email : directoryPerson!.email ?? ""} onChange={event => setEmail(event.target.value)} /></Field>
        </> : null}
        <fieldset className={styles.roleChoices} aria-describedby={submitted && !selected.length ? `${formId}-roles-error` : undefined}>
          <legend>Assign roles <span className={styles.muted}>Choose at least one</span></legend>
          {roles.map(role => <label key={role.id} className={styles.roleChoice} data-selected={selected.includes(role.id)}>
            <input type="checkbox" checked={selected.includes(role.id)} disabled={ownAdmin && role.id === "Platform.Admin" && selected.includes(role.id)} onChange={event => setSelected(current => event.target.checked ? [...current, role.id] : current.filter(id => id !== role.id))} />
            <span><strong>{role.name}</strong><span>{role.description}</span></span>
          </label>)}
          {submitted && !selected.length ? <InlineMessage tone="error"><span id={`${formId}-roles-error`}>Choose at least one role.</span></InlineMessage> : null}
        </fieldset>
        {ownAdmin ? <p className={styles.muted}>Your administrator role is required to retain access to user management.</p> : null}
        <details className={styles.accessPreview}><summary>{actions.length} effective permissions</summary><ul className={styles.permissions}>{actions.map(action => <li key={action}><code>{action}</code></li>)}</ul></details>
        <Field label="Reason for change" hint="Saved with your identity in the access audit history."><TextInput required maxLength={600} value={reason} onChange={event => setReason(event.target.value)} /></Field>
      </fieldset>
      {command.error ? <ApiErrorView error={command.error} /> : null}
    </form>
  </Sheet>;
}
