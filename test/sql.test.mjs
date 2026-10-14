// The sql source: read-only queries through the database's own client.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkReadOnly, checkSql, sqlCommand } from "../src/bricks/sql.mjs";
import { fillInputs } from "../src/bricks/inputs.mjs";
import { validate, reach } from "../src/bricks/catalog.mjs";
import { parse } from "../src/bricks/data.mjs";

test("only one reading statement runs", () => {
  for (const q of ["SELECT 1", "with a as (select 1) select * from a;", "  -- note\nSELECT 'drop table x' AS s", "EXPLAIN SELECT 1", "SHOW TABLES"]) checkReadOnly(q);
  for (const q of ["DELETE FROM t", "SELECT 1; DROP TABLE t", "WITH d AS (DELETE FROM t RETURNING *) SELECT * FROM d",
    "UPDATE t SET a=1", "ATTACH 'x.db' AS x", "", "PRAGMA writable_schema=1", "select 1; -- ok\n insert into t values (1)"]) {
    assert.throws(() => checkReadOnly(q), q);
  }
});

test("a sql source is validated, needs approval as written, and quotes in input values stay inside the string", () => {
  const spec = { sources: { s: { brick: "sql", engine: "sqlite", db: "app.db", query: "SELECT * FROM t WHERE name = '{{in.q}}'" } },
    inputs: { q: { kind: "text" } }, views: [{ id: "t", brick: "table", source: "s" }] };
  const v = validate(spec);
  assert.deepEqual(v.errors, []);
  assert.equal(reach(v.spec, "/tmp")[0].kind, "sql");
  assert.ok(checkSql({ engine: "oracle", query: "SELECT 1" }, "s").length);
  assert.ok(checkSql({ engine: "sqlite", query: "SELECT 1" }, "s").some((e) => e.includes(".db")), "sqlite needs its file");
  assert.ok(checkSql({ engine: "postgres", query: "DELETE FROM t" }, "s").length);
  const filled = fillInputs(spec.sources.s, { q: "x' OR '1'='1" }).value;
  assert.equal(filled.query, "SELECT * FROM t WHERE name = 'x'' OR ''1''=''1'");
  checkReadOnly(filled.query);
});

test("clients: read-only flags and the output format each prints", () => {
  const pg = sqlCommand({ engine: "postgres", db: "postgres://localhost/app", query: "SELECT 1;" }, (p) => p);
  assert.deepEqual(pg.argv.slice(0, 3), ["psql", "postgres://localhost/app", "-X"]);
  assert.equal(pg.argv.at(-1), "SELECT 1");
  assert.match(pg.env.PGOPTIONS, /read_only=on/);
  assert.ok(sqlCommand({ engine: "sqlite", db: "a.db", query: "SELECT 1" }, (p) => "/w/" + p).argv.includes("-readonly"));
  assert.deepEqual(parse("a\tb\n1\t2\n", "tsv"), [{ a: "1", b: "2" }]);
});

test("sqlite end to end, when sqlite3 is installed", { skip: (() => { try { execFileSync("sqlite3", ["-version"]); return false; } catch { return true; } })() }, () => {
  const dir = mkdtempSync(join(tmpdir(), "taksim-sql-"));
  const db = join(dir, "app.db");
  execFileSync("sqlite3", [db, "CREATE TABLE orders(status TEXT); INSERT INTO orders VALUES ('paid'),('paid'),('open');"]);
  const q = sqlCommand({ engine: "sqlite", db: "app.db", query: "SELECT status, count(*) AS n FROM orders GROUP BY status ORDER BY status" }, (p) => join(dir, p));
  const rows = parse(execFileSync(q.argv[0], q.argv.slice(1), { encoding: "utf8" }), q.parse);
  assert.deepEqual(rows, [{ status: "open", n: 1 }, { status: "paid", n: 2 }]);
  // the client itself refuses writes too
  assert.throws(() => execFileSync("sqlite3", ["-readonly", db, "INSERT INTO orders VALUES ('x')"], { stdio: "pipe" }));
  rmSync(dir, { recursive: true, force: true });
});

test("schema mode: validation, per-engine statements, hostile table names", () => {
  assert.deepEqual(checkSql({ engine: "sqlite", db: "a.db", schema: "tables" }, "s"), []);
  assert.ok(checkSql({ engine: "sqlite", db: "a.db", schema: "tables", query: "SELECT 1" }, "s").some((e) => e.includes("not with schema")));
  assert.ok(checkSql({ engine: "sqlite", db: "a.db", schema: "columns" }, "s").some((e) => e.includes(".table")));
  assert.ok(checkSql({ engine: "sqlite", db: "a.db", schema: "columns", table: "a;b" }, "s").some((e) => e.includes("plain table name")));
  assert.ok(checkSql({ engine: "nope", db: "a.db", schema: "tables" }, "s").length);
  assert.ok(checkSql({ engine: "sqlite", schema: "tables" }, "s").some((e) => e.includes(".db")), "schema still needs its database");
  for (const engine of ["sqlite", "duckdb", "postgres", "mysql", "clickhouse", "snowflake", "bigquery"]) {
    const t = sqlCommand({ engine, db: engine === "sqlite" || engine === "duckdb" ? "a.db" : "db", schema: "tables" }, (p) => p);
    const q = t.argv.find((a) => /^(SELECT|SHOW|DESCRIBE|PRAGMA)/i.test(a));
    checkReadOnly(q);
  }
  const pg = sqlCommand({ engine: "postgres", db: "app", schema: "columns", table: "orders" }, (p) => p);
  assert.match(pg.argv.at(-1), /table_name = 'orders'/);
  assert.throws(() => sqlCommand({ engine: "postgres", db: "app", schema: "columns", table: "orders; DROP TABLE x" }, (p) => p), /bad table name/);
  assert.throws(() => sqlCommand({ engine: "postgres", db: "app", schema: "columns", table: "x' OR '1'='1" }, (p) => p), /bad table name/);
  const ch = sqlCommand({ engine: "clickhouse", schema: "columns", table: "db.orders" }, (p) => p);
  assert.match(ch.argv.at(-1), /DESCRIBE TABLE `db`\.`orders`/);
});

test("schema mode lists tables and columns, when sqlite3 is installed", { skip: (() => { try { execFileSync("sqlite3", ["-version"]); return false; } catch { return true; } })() }, () => {
  const dir = mkdtempSync(join(tmpdir(), "taksim-sql-"));
  const db = join(dir, "app.db");
  execFileSync("sqlite3", [db, "CREATE TABLE orders(status TEXT); CREATE VIEW v AS SELECT 1 AS one;"]);
  const run = (def) => {
    const q = sqlCommand({ engine: "sqlite", db: "app.db", ...def }, (p) => join(dir, p));
    return parse(execFileSync(q.argv[0], q.argv.slice(1), { encoding: "utf8" }), q.parse);
  };
  assert.deepEqual(run({ schema: "tables" }), [{ table_name: "orders", type: "table" }, { table_name: "v", type: "view" }]);
  const cols = run({ schema: "columns", table: "orders" });
  assert.deepEqual(cols.map((c) => c.name), ["status"]);
  // through an input, like a panel would fill it
  const filled = fillInputs({ brick: "sql", engine: "sqlite", db: "app.db", schema: "columns", table: "{{in.t}}" }, { t: "orders" }).value;
  assert.deepEqual(run(filled).map((c) => c.name), ["status"]);
  assert.throws(() => sqlCommand({ engine: "sqlite", db: "app.db", schema: "columns", table: fillInputs({ brick: "sql", engine: "sqlite", db: "a", schema: "columns", table: "{{in.t}}" }, { t: "x; SELECT" }).value.table }, (p) => p), /bad table name/);
  rmSync(dir, { recursive: true, force: true });
});
