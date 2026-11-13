import { usePolled } from "@ehf/ui-client/react";
import { Button, Field, InlineMessage, Select, Sheet, TextArea } from "@ehf/ui-kit";
import { useEffect, useState } from "react";
import { api } from "../../../app/api";
import { useSession } from "../../../app/session";
import { ApiErrorView, Region, useCommand } from "../../../platform/common";
import type { CaseRoom } from "./case-reads";
import styles from "./work.module.css";

type Assignment = NonNullable<CaseRoom["assignment"]>;

/** "Team · person, person" or the honest alternative. `undefined` means the service did not report it. */
export function assignmentText(assignment: Assignment | null | undefined): string {
  if (assignment === undefined) return "Not reported";
  if (assignment === null) return "Unassigned";
  return assignment.assignees.length ? `${assignment.team.name} · ${assignment.assignees.join(", ")}` : `${assignment.team.name} · no one named`;
}

/**
 * Who the case is assigned to (docs/implementation/case-access-model.md, step 1). Shown to
 * everyone who can read the case; changing it needs case.assign. Assignment does not restrict
 * access yet, and the panel says so rather than implying it does.
 */
export function AssignmentPanel({ room }: { room: CaseRoom }) {
  const session = useSession();
  const [assigning, setAssigning] = useState(false);
  const assignment = room.assignment;
  const canAssign = session.actions.includes("case.assign");
  return (
    <section aria-labelledby="assignment-title" className={styles.customer}>
      <div id="assignment-title" className="t-engraved">Assigned to</div>
      {assignment ? (
        <dl className={styles.kv}>
          <dt>Team</dt><dd>{assignment.team.name}</dd>
          <dt>People</dt><dd>{assignment.assignees.length ? assignment.assignees.join(", ") : "No one named"}</dd>
        </dl>
      ) : <p className={styles.muted}>{assignment === null ? "This case is not assigned to a team." : "Assignment is not reported for this case."}</p>}
      {canAssign ? <div className={styles.actions}><Button size="sm" onClick={() => setAssigning(true)}>{assignment ? "Reassign" : "Assign"}</Button></div> : null}
      {assigning ? <AssignSheet room={room} onClose={() => setAssigning(false)} /> : null}
    </section>
  );
}

function AssignSheet({ room, onClose }: { room: CaseRoom; onClose: () => void }) {
  const caseId = room.caseId;
  const teams = usePolled(api, "getFincrimeTeams");
  const assign = useCommand("postFincrimeCasesCaseIdAssignment", { invalidate: [["getFincrimeCasesCaseIdRoom", { path: { caseId } }], ["getFincrimeWork"]] });
  const [teamId, setTeamId] = useState(room.assignment?.team.teamId ?? "");
  const [assignees, setAssignees] = useState<string[]>(room.assignment?.assignees ?? []);
  const [reason, setReason] = useState("");
  // One key per opening, so retrying the same assignment cannot record it twice.
  const [idempotencyKey] = useState(() => `assign_${crypto.randomUUID()}`);
  const [basis, setBasis] = useState(room.caseSequence);
  const done = assign.result?.outcome === "ACCEPTED";
  const moved = !done && !assign.busy && basis !== room.caseSequence;
  const team = teams.data?.teams.find((entry) => entry.teamId === teamId);

  // People are named within a team: changing the team drops anyone who is not in it.
  useEffect(() => {
    if (team) setAssignees((current) => current.filter((subject) => team.members.includes(subject)));
  }, [team]);

  const ready = Boolean(team) && reason.trim().length > 0 && !moved;
  const submit = () => void assign.run({ path: { caseId }, body: { teamId, assignees, reason: reason.trim(), expectedCaseSequence: basis, idempotencyKey } });

  return (
    <Sheet
      open onClose={onClose} title={room.assignment ? "Reassign the case" : "Assign the case"}
      description={`${room.subject.name} · ${caseId}`}
      footer={done ? <Button variant="primary" onClick={onClose}>Done</Button> : (
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" busy={assign.busy} disabled={!ready || assign.busy} onClick={submit}>{room.assignment ? "Reassign" : "Assign"}</Button>
        </>
      )}
    >
      {done ? (
        <InlineMessage tone="ok">Assigned. The case now reads sequence <span className="num">{assign.result!.caseSequence}</span>.</InlineMessage>
      ) : (
        <div className={styles.stack}>
          <p className={styles.muted}>
            Assignment is recorded on the case ledger under your name. It does not yet change who can open or act on the case.
          </p>
          {moved ? (
            <div className={styles.section} role="alert">
              <InlineMessage tone="warn">The case changed while this was open (sequence {basis} → {room.caseSequence}).</InlineMessage>
              <div className={styles.actions}><Button onClick={() => setBasis(room.caseSequence)}>Assign on the current case</Button></div>
            </div>
          ) : null}
          <Region polled={teams} label="teams">
            {(data) => (
              <>
                <Field label="Team">
                  <Select value={teamId} onChange={(event) => setTeamId(event.target.value)}>
                    <option value="">Choose a team</option>
                    {data.teams.map((entry) => <option key={entry.teamId} value={entry.teamId}>{entry.name}</option>)}
                  </Select>
                </Field>
                <fieldset className={styles.choices}>
                  <legend className={styles.eyebrow}>People (optional)</legend>
                  {team ? (team.members.length ? team.members.map((subject) => (
                    <label key={subject} className={styles.choice}>
                      <input type="checkbox" checked={assignees.includes(subject)} onChange={(event) => setAssignees((current) => (event.target.checked ? [...current, subject].sort() : current.filter((entry) => entry !== subject)))} />
                      <span>{subject}</span>
                    </label>
                  )) : <p className={styles.muted}>This team has no members.</p>) : <p className={styles.muted}>Choose a team to name people in it.</p>}
                </fieldset>
              </>
            )}
          </Region>
          <Field label="Reason (required)" hint="Recorded with the assignment.">
            <TextArea value={reason} onChange={(event) => setReason(event.target.value)} rows={3} maxLength={2000} />
          </Field>
          {assign.error ? <ApiErrorView error={assign.error} /> : null}
          {assign.result && !done ? <InlineMessage tone="error">The case service did not accept this ({assign.result.reasonCode ?? assign.result.outcome}). Nothing was recorded.</InlineMessage> : null}
        </div>
      )}
    </Sheet>
  );
}
