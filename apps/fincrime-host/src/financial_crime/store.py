"""SQLite reference store. Transactions serialize local effects and checkpoint results."""
from __future__ import annotations

import sqlite3
import json
from contextlib import contextmanager

from .contracts import Record, SkillError, canonical, digest, now
from .repositories import JobEntry, OutboxEntry
from .versions import SCHEMA_VERSION


class Store:
    def __init__(self, path=":memory:"):
        self.db = sqlite3.connect(path, isolation_level=None, check_same_thread=False)
        self.db.row_factory = sqlite3.Row
        self.db.executescript("""
          PRAGMA foreign_keys=ON;
          PRAGMA busy_timeout=5000;
          CREATE TABLE IF NOT EXISTS records(tenant TEXT, type TEXT, id TEXT, version TEXT, body TEXT, hash TEXT,
              PRIMARY KEY(tenant,type,id,version));
          CREATE TABLE IF NOT EXISTS jobs(tenant TEXT, actor TEXT, key TEXT, request_hash TEXT, body TEXT,
              PRIMARY KEY(tenant,actor,key));
          CREATE TABLE IF NOT EXISTS audit(seq INTEGER PRIMARY KEY AUTOINCREMENT, tenant TEXT, body TEXT, hash TEXT);
          CREATE TABLE IF NOT EXISTS state(tenant TEXT, kind TEXT, id TEXT, revision INTEGER, body TEXT,
              PRIMARY KEY(tenant,kind,id));
          CREATE TABLE IF NOT EXISTS outbox(tenant TEXT, id TEXT, hash TEXT, status TEXT, command TEXT, receipt TEXT,
              PRIMARY KEY(tenant,id));
        """)

    @contextmanager
    def transaction(self):
        self.db.execute("BEGIN IMMEDIATE")
        try:
            yield
        except BaseException:
            self.db.execute("ROLLBACK")
            raise
        else:
            self.db.execute("COMMIT")

    def put(self, record: Record):
        record = Record.model_validate(record.model_dump(mode="python"))
        body, h = canonical(record), digest(record)
        old = self.db.execute("SELECT hash FROM records WHERE tenant=? AND type=? AND id=? AND version=?",
                              (record.tenant_id, record.object_type, record.id, record.version_id)).fetchone()
        if old and old[0] != h:
            raise SkillError("INTEGRITY_FAILURE", "immutable version cannot be overwritten")
        self.db.execute("INSERT OR IGNORE INTO records VALUES(?,?,?,?,?,?)", (record.tenant_id, record.object_type, record.id, record.version_id, body, h))
        return record.ref()

    def records(self, tenant, object_type):
        rows = self.db.execute("SELECT body,hash FROM records WHERE tenant=? AND type=? ORDER BY id,version", (tenant, object_type))
        result = []
        for row in rows:
            if json.loads(row[0]).get("schema_version") != SCHEMA_VERSION:
                raise SkillError("SCHEMA_VERSION_UNSUPPORTED", "stored records require explicit version migration")
            record = Record.model_validate_json(row[0])
            if digest(record) != row[1]:
                raise SkillError("INTEGRITY_FAILURE", "stored record hash mismatch")
            result.append(record)
        return result

    def state(self, tenant, kind, object_id):
        import json
        row = self.db.execute("SELECT revision,body FROM state WHERE tenant=? AND kind=? AND id=?", (tenant, kind, object_id)).fetchone()
        return (row[0], json.loads(row[1])) if row else (0, None)

    def set_state(self, tenant, kind, object_id, expected_revision, data):
        revision, _ = self.state(tenant, kind, object_id)
        if revision != expected_revision:
            raise SkillError("REVISION_CONFLICT", "state changed; re-evaluate inputs")
        self.db.execute("INSERT INTO state VALUES(?,?,?,?,?) ON CONFLICT(tenant,kind,id) DO UPDATE SET revision=excluded.revision,body=excluded.body",
                        (tenant, kind, object_id, revision + 1, canonical(data)))
        return revision + 1

    def event(self, tenant, event):
        previous = self.db.execute("SELECT hash FROM audit WHERE tenant=? ORDER BY seq DESC LIMIT 1", (tenant,)).fetchone()
        body = {"at": now().isoformat(), "previous_hash": previous[0] if previous else None, **event}
        self.db.execute("INSERT INTO audit(tenant,body,hash) VALUES(?,?,?)", (tenant, canonical(body), digest(body)))

    def events(self, tenant):
        import json
        return [json.loads(x[0]) for x in self.db.execute("SELECT body FROM audit WHERE tenant=? ORDER BY seq", (tenant,))]

    def audit_chain(self, tenant):
        return [(json.loads(x[0]), x[1]) for x in self.db.execute("SELECT body,hash FROM audit WHERE tenant=? ORDER BY seq", (tenant,))]

    def get_job(self, tenant, actor, key):
        row = self.db.execute("SELECT request_hash,body FROM jobs WHERE tenant=? AND actor=? AND key=?", (tenant, actor, key)).fetchone()
        return JobEntry(tenant, actor, key, row[0], json.loads(row[1])) if row else None

    def jobs(self, tenant, *, actor=None, request_hash=None):
        query, parameters = "SELECT actor,key,request_hash,body FROM jobs WHERE tenant=?", [tenant]
        if actor is not None:
            query += " AND actor=?"; parameters.append(actor)
        if request_hash is not None:
            query += " AND request_hash=?"; parameters.append(request_hash)
        return [JobEntry(tenant, row[0], row[1], row[2], json.loads(row[3])) for row in self.db.execute(query, parameters)]

    def claim_job(self, tenant, actor, key, request_hash, body, *, resume=False):
        prior = self.get_job(tenant, actor, key)
        if prior:
            if prior.request_hash != request_hash:
                raise SkillError("IDEMPOTENCY_CONFLICT", "job key has different input")
            if prior.body.get("state") == "RUNNING" or not resume:
                raise SkillError("EXECUTION_IN_PROGRESS", "job already claimed", retryable=True)
            self.save_job(tenant, actor, key, body)
        else:
            self.db.execute("INSERT INTO jobs VALUES(?,?,?,?,?)", (tenant, actor, key, request_hash, canonical(body)))

    def save_job(self, tenant, actor, key, body):
        self.db.execute("UPDATE jobs SET body=? WHERE tenant=? AND actor=? AND key=?", (canonical(body), tenant, actor, key))

    def discard_job(self, tenant, actor, key):
        self.db.execute("DELETE FROM jobs WHERE tenant=? AND actor=? AND key=?", (tenant, actor, key))

    def add_outbox(self, tenant, command):
        previous = self.outbox_item(tenant, command["id"])
        h = digest(command)
        if previous and previous.hash != h:
            raise SkillError("IDEMPOTENCY_CONFLICT", "outbox command input changed")
        self.db.execute("INSERT OR IGNORE INTO outbox VALUES(?,?,?,?,?,?)", (tenant, command["id"], h, "PENDING", canonical(command), None))

    def outbox_item(self, tenant, object_id):
        row = self.db.execute("SELECT hash,status,command,receipt FROM outbox WHERE tenant=? AND id=?", (tenant, object_id)).fetchone()
        return OutboxEntry(tenant, object_id, row[0], row[1], json.loads(row[2]), json.loads(row[3]) if row[3] else None) if row else None

    def pending_outbox(self, tenant, limit=100):
        rows = self.db.execute("SELECT id,hash,status,command,receipt FROM outbox WHERE tenant=? AND status IN ('PENDING','UNCERTAIN') ORDER BY id LIMIT ?", (tenant, limit))
        return [OutboxEntry(tenant, row[0], row[1], row[2], json.loads(row[3]), json.loads(row[4]) if row[4] else None) for row in rows]

    def set_outbox_status(self, tenant, object_id, status, receipt=None, *, expected=None):
        sql = "UPDATE outbox SET status=?,receipt=? WHERE tenant=? AND id=?"
        parameters = [status, canonical(receipt) if receipt is not None else None, tenant, object_id]
        if expected is not None:
            sql += " AND status=?"; parameters.append(expected)
        cursor = self.db.execute(sql, parameters)
        if cursor.rowcount != 1:
            raise SkillError("REVISION_CONFLICT", "outbox state changed")

    def close(self):
        self.db.close()

