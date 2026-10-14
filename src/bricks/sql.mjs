// The sql source: a query against a database, through that database's own command-line client (so its
// login, ~/.pgpass, gcloud auth… stay the user's), read-only. Rows come back as JSON or CSV.
//   { brick: "sql", engine: "sqlite" | "duckdb" | "postgres" | "mysql" | "clickhouse" | "bigquery" | "snowflake",
//     db?: file path or connection string, query: "SELECT …", every_s? }
//   { brick: "sql", engine, db?, schema: "tables" } — every table and view, for a schema explorer
//   { brick: "sql", engine, db?, schema: "columns", table: "orders" } — its columns (table may be {{in.t}})
// Only reading queries run: one statement that starts with SELECT / WITH / SHOW / DESCRIBE / EXPLAIN / VALUES /
// TABLE and writes nothing, and where the client can, the session itself is read-only too.

export const SQL_ENGINES = {
  sqlite: { bin: "sqlite3", db: "file", argv: (db, q) => ["sqlite3", "-readonly", "-json", db, q], parse: "json" },
  duckdb: { bin: "duckdb", db: "file", argv: (db, q) => ["duckdb", "-readonly", "-json", db, "-c", q], parse: "json" },
  // the session is read-only (PGOPTIONS), so even a function with side effects can't write
  postgres: { bin: "psql", argv: (db, q) => ["psql", ...(db ? [db] : []), "-X", "--csv", "-v", "ON_ERROR_STOP=1", "-c", q],
    env: { PGOPTIONS: "-c default_transaction_read_only=on" }, parse: "csv" },
  mysql: { bin: "mysql", argv: (db, q) => ["mysql", "--batch", "--raw", "-e", q, ...(db ? [db] : [])], parse: "tsv" },
  clickhouse: { bin: "clickhouse", argv: (db, q) => ["clickhouse", "client", ...(db ? ["--host", db] : []), "--readonly", "1", "--format", "JSONEachRow", "--query", q], parse: "jsonl" },
  bigquery: { bin: "bq", argv: (db, q) => ["bq", "query", "--use_legacy_sql=false", "--format=json", "--max_rows=1000", ...(db ? [`--project_id=${db}`] : []), q], parse: "json" },
  snowflake: { bin: "snow", argv: (db, q) => ["snow", "sql", "--format", "json", ...(db ? ["--connection", db] : []), "-q", q], parse: "json" },
};

const READS = /^(select|with|show|describe|desc|explain|values|table|pragma\s+table_info)\b/i;
const WRITES = /\b(insert|update|delete|merge|upsert|replace|drop|alter|create|truncate|grant|revoke|attach|detach|copy|vacuum|call|exec|execute|set|load|install|lock|unlock|comment|rename|optimize|kill)\b/i;

/** the query without comments and string literals, for checking what it does */
function bare(q) {
  return String(q).replace(/--[^\n]*/g, " ").replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/'(?:[^']|'')*'/g, "''").replace(/"(?:[^"]|"")*"/g, '""').replace(/`[^`]*`/g, "``").trim();
}

/** throws unless the query only reads */
export function checkReadOnly(query) {
  const q = bare(query).replace(/;\s*$/, "");
  if (!q) throw new Error("query is empty");
  if (q.includes(";")) throw new Error("one statement only");
  if (!READS.test(q)) throw new Error("only reading queries (SELECT, WITH, SHOW, DESCRIBE, EXPLAIN)");
  const w = q.match(WRITES);
  if (w) throw new Error(`only reading queries: "${w[1]}" isn't allowed`);
}

/** validation errors for a sql source */
export function checkSql(s, at) {
  const errors = [];
  const e = SQL_ENGINES[s.engine];
  if (!e) errors.push(`${at}.engine: one of ${Object.keys(SQL_ENGINES).join(", ")}`);
  if (s.schema !== undefined) {
    if (!["tables", "columns"].includes(s.schema)) errors.push(`${at}.schema: "tables" or "columns"`);
    if (s.query !== undefined) errors.push(`${at}.query: not with schema (it lists the database itself)`);
    if (s.schema === "columns") {
      if (typeof s.table !== "string" || !s.table.trim()) errors.push(`${at}.table: the table to describe (may be {{in.t}})`);
      else if (!/^[\w.$"\s]+$/.test(s.table.replace(/\{\{\s*in\.\w+\s*\}\}/g, ""))) errors.push(`${at}.table: a plain table name`);
    }
  } else if (typeof s.query !== "string" || !s.query.trim()) errors.push(`${at}.query: the SQL to run`);
  else {
    // {{in.x}} stand for quoted values; check the query as if each were one
    try { checkReadOnly(s.query.replace(/\{\{\s*in\.\w+\s*\}\}/g, "x")); } catch (err) { errors.push(`${at}.query: ${err.message}`); }
  }
  if (e?.db === "file" && (typeof s.db !== "string" || !s.db)) errors.push(`${at}.db: the database file`);
  if (s.db !== undefined && (typeof s.db !== "string" || s.db.startsWith("-"))) errors.push(`${at}.db: a file path or connection name`);
  return errors;
}

// a table name after its {{in.x}} were filled: plain identifiers only (letters, digits, _, $, dots)
const TABLE_OK = /^[A-Za-z_][\w$]*(\.[A-Za-z_][\w$]*)*$/;
const qlit = (t) => `'${t.replace(/'/g, "''")}'`;

/** the read-only statement listing tables or columns; table is already filled in */
export function schemaQuery(engine, mode, table, db = "") {
  if (mode === "tables") {
    switch (engine) {
      case "sqlite": return "SELECT name AS table_name, type FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY name";
      case "duckdb":
      case "postgres":
      case "mysql": return "SELECT table_name, table_type AS type FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog','information_schema','mysql','performance_schema','sys') ORDER BY table_name";
      case "clickhouse": return "SHOW TABLES";
      case "snowflake": return "SHOW TABLES";
      case "bigquery": return `SELECT table_name, table_type AS type FROM ${db && db.includes(".") ? `${db}.` : ""}INFORMATION_SCHEMA.TABLES ORDER BY table_name`;
      default: throw new Error(`unknown engine ${engine}`);
    }
  }
  if (!TABLE_OK.test(String(table || ""))) throw new Error(`bad table name ${JSON.stringify(String(table))}: plain dotted names only`);
  const t = String(table);
  switch (engine) {
    case "sqlite": return `SELECT cid, name, type, "notnull", dflt_value, pk FROM pragma_table_info(${qlit(t)})`;
    case "duckdb":
    case "postgres":
    case "mysql": return `SELECT column_name AS name, data_type AS type, is_nullable AS nullable FROM information_schema.columns WHERE table_name = ${qlit(t)} ORDER BY ordinal_position`;
    case "clickhouse": return `DESCRIBE TABLE ${t.split(".").map((p) => `\`${p}\``).join(".")}`;
    case "snowflake": return `DESCRIBE TABLE ${t.split(".").map((p) => `"${p}"`).join(".")}`;
    case "bigquery": return `SELECT column_name AS name, data_type AS type FROM ${db && db.includes(".") ? `${db}.` : ""}INFORMATION_SCHEMA.COLUMNS WHERE table_name = ${qlit(t)} ORDER BY ordinal_position`;
    default: throw new Error(`unknown engine ${engine}`);
  }
}

/** how to run it: argv, extra env, and how to read the output */
export function sqlCommand(s, resolveFile) {
  const e = SQL_ENGINES[s.engine];
  if (!e) throw new Error(`unknown engine ${s.engine}`);
  if (s.schema) {
    const db = e.db === "file" ? resolveFile(s.db) : s.db || "";
    return { argv: e.argv(db, schemaQuery(s.engine, s.schema, s.table, s.db || "")), env: e.env || {}, parse: e.parse };
  }
  checkReadOnly(s.query);
  const db = e.db === "file" ? resolveFile(s.db) : s.db || "";
  return { argv: e.argv(db, s.query.trim().replace(/;\s*$/, "")), env: e.env || {}, parse: e.parse };
}
