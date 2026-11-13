"""Durable local submission driver. Unknown acknowledgment is reconciled before retry."""
import json

from .contracts import SkillError, canonical, digest


class LocalRegulator:
    """Synthetic receiver with durable idempotent receipts in the reference store."""
    def __init__(self, store):
        self.store = store

    def submit(self, tenant, submission_id, filing):
        revision, receipt = self.store.state(tenant, "local-regulator", submission_id)
        if receipt:
            if receipt["filing_hash"] != digest(filing):
                raise SkillError("IDEMPOTENCY_CONFLICT", "submission content changed")
            return receipt
        receipt = {"receipt_id": "synthetic-"+submission_id[:16], "filing_hash": digest(filing), "accepted_by_local_test_endpoint": True, "synthetic": True}
        with self.store.transaction():
            self.store.set_state(tenant, "local-regulator", submission_id, revision, receipt)
        return receipt

    def reconcile(self, tenant, submission_id):
        return self.store.state(tenant, "local-regulator", submission_id)[1]


class OutboxWorker:
    def __init__(self, store, receiver):
        self.store, self.receiver = store, receiver

    def drain_submissions(self, tenant, *, limit=100):
        results = []
        rows = self.store.pending_outbox(tenant, limit)
        for row in rows:
            command = row.command
            if command.get("action") != "submit_filing" or not command.get("synthetic"):
                continue
            sid = row.id
            # Mark uncertainty before crossing the receiver boundary; a crash must reconcile.
            self.store.set_outbox_status(tenant, sid, "UNCERTAIN", expected=row.status)
            receipt = self.receiver.reconcile(tenant, sid)
            if receipt is None and row.status == "UNCERTAIN":
                results.append({"id": sid, "state": "UNCERTAIN", "reason": "EXTERNAL_ACTION_UNCONFIRMED"})
                continue
            if receipt is None:
                receipt = self.receiver.submit(tenant, sid, command["filing"])
            self.store.set_outbox_status(tenant, sid, "CONFIRMED", receipt, expected="UNCERTAIN")
            self.store.event(tenant, {"event": "submission_confirmed", "submission_id": sid, "receipt_hash": digest(receipt)})
            results.append({"id": sid, "state": "CONFIRMED"})
        return results
