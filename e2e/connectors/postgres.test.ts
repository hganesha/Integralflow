import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, connect } from "node:net";
import { TLSSocket, createSecureContext } from "node:tls";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { contextConnectionSchema, contextBindingSchema } from "@ehf/contracts";
import { createDatabase } from "@ehf/persistence";
import { runContextConnector } from "../../packages/context-connectors/src/index.js";
import fixture from "../../packages/contracts/test-fixtures/context-source.json" with { type: "json" };

describe.skipIf(!process.env.EHF_TEST_DATABASE_URL)(
  "native PostgreSQL transport",
  () => {
    it("uses verified TLS and a read-only login for scoped discovery and parameterized reads", async () => {
      const url = new URL(process.env.EHF_TEST_DATABASE_URL!);
      if (!["127.0.0.1", "localhost"].includes(url.hostname))
        throw new Error("Use an isolated local test database");
      const db = createDatabase(url.toString()),
        directory = await mkdtemp(join(tmpdir(), "context-pg-tls-"));
      const suffix = randomUUID().replaceAll("-", "").slice(0, 12),
        role = `context_reader_${suffix}`,
        schema = `context_test_${suffix}`,
        password = randomBytes(32).toString("hex");
      execFileSync(
        "openssl",
        [
          "req",
          "-x509",
          "-newkey",
          "rsa:2048",
          "-nodes",
          "-keyout",
          join(directory, "key.pem"),
          "-out",
          join(directory, "cert.pem"),
          "-days",
          "1",
          "-subj",
          "/CN=localhost",
          "-addext",
          "subjectAltName=IP:127.0.0.1,DNS:localhost",
        ],
        { stdio: "ignore" },
      );
      const cert = await readFile(join(directory, "cert.pem")),
        key = await readFile(join(directory, "key.pem"));
      const secureContext = createSecureContext({ key, cert });
      let sessions = 0;
      // Test-only PostgreSQL SSLRequest bridge. It verifies TLS on the actual driver path
      // while the CI database can keep its standard local-only server configuration.
      const bridge = createServer((socket) => {
        socket.once("data", (initial) => {
          if (
            !Buffer.isBuffer(initial) ||
            initial.length !== 8 ||
            initial.readInt32BE(4) !== 80877103
          ) {
            socket.destroy();
            return;
          }
          socket.write("S");
          const secure = new TLSSocket(socket, {
            isServer: true,
            secureContext,
          });
          secure.on("error", () => secure.destroy());
          secure.once("secure", () => {
            sessions++;
            const upstream = connect(
              { host: url.hostname, port: Number(url.port || 5432) },
              () => {
                secure.pipe(upstream);
                upstream.pipe(secure);
              },
            );
            upstream.on("error", () => secure.destroy());
            secure.on("close", () => upstream.destroy());
          });
        });
      });
      await new Promise<void>((resolve) =>
        bridge.listen(0, "127.0.0.1", resolve),
      );
      const address = bridge.address();
      if (!address || typeof address === "string")
        throw new Error("bridge.listen_failed");
      try {
        // These identifiers and the password are generated above from hex, never supplied
        // by a caller. The role cannot create objects or modify the fixture table.
        await db.query(
          `create role ${role} login password '${password}' nosuperuser nocreatedb nocreaterole`,
        );
        await db.query(`create schema ${schema}`);
        await db.query(
          `create table ${schema}.customers(id text primary key,name text not null,entity_type text not null,identifiers jsonb not null,observed_at timestamptz not null)`,
        );
        await db.query(
          `insert into ${schema}.customers values ($1,$2,'company','[]'::jsonb,now()-interval '1 second')`,
          ["customer-1", "Synthetic native customer"],
        );
        await db.query(
          `grant connect on database ${url.pathname.slice(1)} to ${role}`,
        );
        await db.query(`grant usage on schema ${schema} to ${role}`);
        await db.query(`grant select on ${schema}.customers to ${role}`);
        const connection = contextConnectionSchema.parse({
          ...fixture.connection,
          endpoint: `postgresql://127.0.0.1:${address.port}${url.pathname}`,
          resource: {
            ...fixture.connection.resource,
            database: url.pathname.slice(1),
            schema,
          },
        });
        const binding = contextBindingSchema.parse(fixture.binding);
        const runtime = {
          tenantId: "native-test",
          env: {
            CUSTOMER_DB: JSON.stringify({ username: role, password }),
            CONTEXT_SOURCE_CA_PEM: cert.toString(),
            CONTEXT_SOURCE_TARGETS_JSON: JSON.stringify({
              "native-test": [
                {
                  endpoint: connection.endpoint,
                  provider: "postgresql",
                  credentialRef: connection.credentialRef,
                },
              ],
            }),
          },
          fetch: globalThis.fetch,
          checkTransport: async (endpoint: URL) => {
            expect(endpoint.toString()).toBe(connection.endpoint);
          },
        };
        const discovered = await runContextConnector(
          connection,
          binding,
          { customer_id: "customer-1" },
          runtime,
          true,
        );
        expect(discovered.fields.map((f) => f.name)).toEqual([
          "id",
          "name",
          "entity_type",
          "identifiers",
          "observed_at",
        ]);
        const result = await runContextConnector(
          connection,
          binding,
          { customer_id: "customer-1" },
          runtime,
        );
        expect(result.rows[0]).toMatchObject({
          name: "Synthetic native customer",
        });
        expect(result.schemaFingerprint).toBe(discovered.schemaFingerprint);
        expect(
          (
            await db.query(
              "select has_table_privilege($1,$2,'UPDATE') as allowed",
              [role, `${schema}.customers`],
            )
          ).rows[0].allowed,
        ).toBe(false);
        const malicious = await runContextConnector(
          connection,
          binding,
          { customer_id: "'; DELETE FROM customers; --" },
          runtime,
        );
        expect(malicious.rows).toEqual([]);
        expect(sessions).toBe(3);
      } finally {
        await new Promise<void>((resolve) => bridge.close(() => resolve()));
        await db.query(`drop schema if exists ${schema} cascade`);
        await db.query(`drop owned by ${role}`);
        await db.query(`drop role if exists ${role}`);
        await db.end();
        await rm(directory, { recursive: true, force: true });
      }
    }, 30000);
  },
);
