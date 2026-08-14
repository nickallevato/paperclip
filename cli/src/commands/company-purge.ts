/**
 * `paperclipai company purge` — hard-delete one or more companies and every
 * row that belongs to them, directly against Postgres.
 *
 * Why this exists (and why it does not go through the API)
 * --------------------------------------------------------
 * `DELETE /api/companies/:id` (server/src/services/companies.ts -> remove())
 * deletes a hand-maintained list of ~30 tables in a fixed order. That list has
 * two structural problems:
 *
 *   1. Ordering. It deletes `heartbeat_runs` before `cost_events`, but
 *      `cost_events.heartbeat_run_id -> heartbeat_runs` is ON DELETE NO ACTION,
 *      so the whole transaction aborts with a foreign key violation on any
 *      company that has cost history. The delete simply never succeeds.
 *   2. Coverage. 145 tables carry a `company_id`, and plugins add more at
 *      install time in their own `plugin_*` schemas. A list written by hand
 *      cannot stay complete, and every gap is a future FK violation.
 *
 * This command fixes both by deriving the work from the live catalog instead
 * of a literal list:
 *
 *   - Targets are discovered by introspection: every BASE TABLE in every schema
 *     that has a `company_id` column. Plugin schemas are picked up for free.
 *   - Tables that reference company-scoped rows but have no `company_id` of
 *     their own (for example `decision_effect_executions`, `status_card_updates`)
 *     are deleted through a join, but only when their FK is NO ACTION/RESTRICT.
 *     CASCADE and SET NULL are left to Postgres, which is both correct and less
 *     destructive.
 *   - Order is discovered, not maintained. Every DELETE runs inside a SAVEPOINT;
 *     a foreign key violation rolls back just that statement and the table is
 *     retried on the next pass. The loop ends when a pass makes no progress.
 *
 * Foreign keys stay ENABLED throughout. It is tempting to reach for
 * `session_replication_role = 'replica'` (the CLI's DB role is superuser, so it
 * would work), but that disables FK *triggers* wholesale — including the ~88
 * ON DELETE CASCADE edges and the plugin schemas that depend on them. You would
 * trade a loud, safe failure for silent orphans. Letting Postgres keep checking
 * is the point: if this command commits, referential integrity held.
 *
 * Safety model
 * ------------
 *   - Dry run is the default. The real DELETEs execute inside a transaction
 *     that is then ROLLBACK'd, so a dry run reports exact per-table row counts
 *     and proves the purge would succeed, with zero risk.
 *   - `--apply` commits, and additionally requires `--yes` and `--confirm`.
 *   - A backup runs before any committing purge unless `--no-backup`.
 *   - Preflight refuses to run if a company *outside* the target set references
 *     data *inside* it. Pass companies as a set to purge mutually-referencing
 *     companies together.
 */
import * as p from "@clack/prompts";
import pc from "picocolors";
import postgres from "postgres";
import type { Command } from "commander";
import { formatDatabaseBackupResult, runDatabaseBackup } from "@paperclipai/db";
import {
  expandHomePrefix,
  resolveDefaultBackupDir,
  resolvePaperclipInstanceId,
} from "../config/home.js";
import { readConfig } from "../config/store.js";
import path from "node:path";

/** Postgres SQLSTATE for foreign_key_violation. */
const FK_VIOLATION = "23503";

const SYSTEM_SCHEMAS = ["pg_catalog", "information_schema", "pg_toast"];

interface CompanyPurgeOptions {
  config?: string;
  apply?: boolean;
  yes?: boolean;
  confirm?: string;
  backup?: boolean;
  fkIndexes?: boolean;
  json?: boolean;
}

interface TargetCompany {
  id: string;
  name: string;
  issuePrefix: string;
}

/** A single DELETE the purge needs to land, plus how many rows it removed. */
export interface PurgeStep {
  /** Display key, e.g. `public.issues` or `public.status_card_updates <- issues`. */
  label: string;
  /** `schema.table` this step deletes from; used to order steps by FK depth. */
  tableKey: string;
  sql: string;
  deleted: number | null;
}

export interface ForeignKey {
  name: string;
  childSchema: string;
  childTable: string;
  childColumn: string;
  parentSchema: string;
  parentTable: string;
  parentColumn: string;
  /** pg_constraint.confdeltype: a=NO ACTION, r=RESTRICT, c=CASCADE, n=SET NULL, d=SET DEFAULT */
  deleteRule: string;
}

function quoteIdent(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function qualify(schema: string, table: string): string {
  return `${quoteIdent(schema)}.${quoteIdent(table)}`;
}

function tableKey(schema: string, table: string): string {
  return `${schema}.${table}`;
}

/**
 * Mirrors db:backup's resolution so both commands agree on which database they
 * are talking to: DATABASE_URL wins, then an explicit connection string in
 * config, then the embedded Postgres port.
 */
function resolveConnectionString(configPath?: string): { value: string; source: string } {
  const envUrl = process.env.DATABASE_URL?.trim();
  if (envUrl) return { value: envUrl, source: "DATABASE_URL" };

  const config = readConfig(configPath);
  if (config?.database.mode === "postgres" && config.database.connectionString?.trim()) {
    return {
      value: config.database.connectionString.trim(),
      source: "config.database.connectionString",
    };
  }

  const port = config?.database.embeddedPostgresPort ?? 54329;
  return {
    value: `postgres://paperclip:paperclip@127.0.0.1:${port}/paperclip`,
    source: `embedded-postgres@${port}`,
  };
}

/**
 * Resolve free-form selectors (UUID, issue prefix, or exact name) to companies.
 * Every selector must match exactly one company, so a typo fails loudly rather
 * than silently purging a subset.
 */
async function resolveTargets(
  sql: postgres.Sql,
  selectors: string[],
): Promise<TargetCompany[]> {
  const rows = await sql<TargetCompany[]>`
    SELECT id, name, issue_prefix AS "issuePrefix"
    FROM public.companies
  `;

  const resolved = new Map<string, TargetCompany>();
  for (const selector of selectors) {
    const needle = selector.trim().toLowerCase();
    const matches = rows.filter(
      (row) =>
        row.id.toLowerCase() === needle ||
        row.issuePrefix.toLowerCase() === needle ||
        row.name.toLowerCase() === needle,
    );
    if (matches.length === 0) {
      throw new Error(`No company matched selector '${selector}'.`);
    }
    if (matches.length > 1) {
      const detail = matches.map((m) => `${m.name} (${m.id})`).join(", ");
      throw new Error(
        `Selector '${selector}' is ambiguous and matched ${matches.length} companies: ${detail}. Use the company ID.`,
      );
    }
    resolved.set(matches[0]!.id, matches[0]!);
  }
  return [...resolved.values()];
}

/** Every BASE TABLE, in any schema, carrying a `company_id` column. */
async function discoverScopedTables(
  sql: postgres.Sql,
): Promise<Array<{ schema: string; table: string }>> {
  const rows = await sql<Array<{ schema: string; table: string }>>`
    SELECT c.table_schema AS schema, c.table_name AS table
    FROM information_schema.columns c
    JOIN information_schema.tables t
      ON t.table_schema = c.table_schema
     AND t.table_name = c.table_name
     AND t.table_type = 'BASE TABLE'
    WHERE c.column_name = 'company_id'
      AND c.table_schema <> ALL(${SYSTEM_SCHEMAS})
    ORDER BY 1, 2
  `;
  return rows;
}

/** All single-column foreign keys in the database, with their ON DELETE rule. */
async function discoverForeignKeys(sql: postgres.Sql): Promise<ForeignKey[]> {
  return sql<ForeignKey[]>`
    SELECT
      con.conname                        AS name,
      cn.nspname                         AS "childSchema",
      cl.relname                         AS "childTable",
      ca.attname                         AS "childColumn",
      pn.nspname                         AS "parentSchema",
      pr.relname                         AS "parentTable",
      pa.attname                         AS "parentColumn",
      con.confdeltype                    AS "deleteRule"
    FROM pg_constraint con
    JOIN pg_class cl      ON cl.oid = con.conrelid
    JOIN pg_namespace cn  ON cn.oid = cl.relnamespace
    JOIN pg_class pr      ON pr.oid = con.confrelid
    JOIN pg_namespace pn  ON pn.oid = pr.relnamespace
    JOIN pg_attribute ca  ON ca.attrelid = con.conrelid AND ca.attnum = con.conkey[1]
    JOIN pg_attribute pa  ON pa.attrelid = con.confrelid AND pa.attnum = con.confkey[1]
    WHERE con.contype = 'f'
      AND array_length(con.conkey, 1) = 1
      AND cn.nspname <> ALL(${SYSTEM_SCHEMAS})
  `;
}

/**
 * Refuse to purge if a company outside the target set points at rows inside it.
 * Deleting anyway would either fail on an FK or strand the outsider's data.
 *
 * The fix is almost always to widen the target set — mutually-referencing
 * companies should be purged together.
 */
async function findExternalDependents(
  sql: postgres.Sql,
  fks: ForeignKey[],
  scoped: Set<string>,
  targetIds: string[],
): Promise<Array<{ fk: string; count: number }>> {
  const isCompaniesParent = (fk: ForeignKey) =>
    fk.parentSchema === "public" && fk.parentTable === "companies";

  const relevant = fks.filter(
    (fk) =>
      scoped.has(tableKey(fk.childSchema, fk.childTable)) &&
      scoped.has(tableKey(fk.parentSchema, fk.parentTable)) &&
      // A row's own `company_id` says which company owns it, not which company
      // depends on it — every scoped table has one, and it is never a dependency.
      // Other columns pointing at `companies` are real cross-company references
      // and are checked separately below.
      !(isCompaniesParent(fk) && fk.childColumn === "company_id"),
  );

  const hits: Array<{ fk: string; count: number }> = [];
  for (const fk of relevant) {
    // EXISTS + LIMIT 1 rather than count(*): this runs once per foreign key
    // (hundreds of them), and all we need is whether the edge is clean. Only
    // the rare dirty edge pays for an exact count.
    // Which parent rows belong to the purge. `companies` is keyed on its own
    // id; every other scoped table carries a company_id.
    const parentFilter = isCompaniesParent(fk) ? "pa.id = ANY($1)" : "pa.company_id = ANY($1)";
    const where = `${parentFilter} AND NOT (ch.company_id = ANY($1))`;
    const from = `
      FROM ${qualify(fk.childSchema, fk.childTable)} ch
      JOIN ${qualify(fk.parentSchema, fk.parentTable)} pa
        ON ch.${quoteIdent(fk.childColumn)} = pa.${quoteIdent(fk.parentColumn)}
    `;

    const [found] = await sql.unsafe<Array<{ dirty: boolean }>>(
      `SELECT EXISTS (SELECT 1 ${from} WHERE ${where} LIMIT 1) AS dirty`,
      [targetIds as never],
    );
    if (!found?.dirty) continue;

    const [row] = await sql.unsafe<Array<{ count: number }>>(
      `SELECT count(*)::int AS count ${from} WHERE ${where}`,
      [targetIds as never],
    );
    hits.push({
      fk: `${fk.childSchema}.${fk.childTable}.${fk.childColumn} -> ${fk.parentSchema}.${fk.parentTable}`,
      count: row?.count ?? 0,
    });
  }
  return hits;
}

/**
 * Build every DELETE the purge needs:
 *   - one per company-scoped table, keyed on `company_id`
 *   - one per NO ACTION/RESTRICT foreign key arriving from a table that has no
 *     `company_id`, joined back to the scoped parent
 *
 * CASCADE and SET NULL edges are deliberately omitted — Postgres already
 * handles those, and deleting SET NULL children would destroy rows that merely
 * mention the company rather than belong to it.
 */
export function buildSteps(
  scopedTables: Array<{ schema: string; table: string }>,
  fks: ForeignKey[],
  scoped: Set<string>,
): PurgeStep[] {
  const steps: PurgeStep[] = scopedTables.map(({ schema, table }) => ({
    label: tableKey(schema, table),
    tableKey: tableKey(schema, table),
    sql: `DELETE FROM ${qualify(schema, table)} WHERE company_id = ANY($1)`,
    deleted: null,
  }));

  const restrictive = fks.filter(
    (fk) =>
      !scoped.has(tableKey(fk.childSchema, fk.childTable)) &&
      (fk.deleteRule === "a" || fk.deleteRule === "r") &&
      (scoped.has(tableKey(fk.parentSchema, fk.parentTable)) ||
        (fk.parentSchema === "public" && fk.parentTable === "companies")),
  );

  for (const fk of restrictive) {
    const isCompanies = fk.parentSchema === "public" && fk.parentTable === "companies";
    const parentFilter = isCompanies ? "pa.id = ANY($1)" : "pa.company_id = ANY($1)";
    steps.push({
      label: `${fk.childSchema}.${fk.childTable} <- ${fk.parentTable}`,
      tableKey: tableKey(fk.childSchema, fk.childTable),
      sql: `
        DELETE FROM ${qualify(fk.childSchema, fk.childTable)} ch
        USING ${qualify(fk.parentSchema, fk.parentTable)} pa
        WHERE ch.${quoteIdent(fk.childColumn)} = pa.${quoteIdent(fk.parentColumn)}
          AND ${parentFilter}
      `,
      deleted: null,
    });
  }

  return steps;
}

/**
 * Sort steps so children are deleted before the tables they reference.
 *
 * The retry loop below is correct on its own, but order still matters for
 * speed: a DELETE that violates a foreign key does all of its work *before*
 * the constraint fires, so a bad initial order re-deletes (and discards) tens
 * of thousands of rows on every pass. Seeding a good order turns what would be
 * a dozen passes into roughly one.
 *
 * Only NO ACTION and RESTRICT edges constrain ordering — CASCADE and SET NULL
 * are resolved by Postgres and cannot fail. Cycles are left for the retry loop
 * rather than broken here.
 */
export function orderSteps(steps: PurgeStep[], fks: ForeignKey[]): PurgeStep[] {
  const byTable = new Map<string, PurgeStep[]>();
  for (const step of steps) {
    const key = step.tableKey;
    const list = byTable.get(key);
    if (list) list.push(step);
    else byTable.set(key, [step]);
  }

  // dependents[parent] = children that must be deleted first.
  const dependents = new Map<string, Set<string>>();
  const indegree = new Map<string, number>();
  for (const key of byTable.keys()) indegree.set(key, 0);

  for (const fk of fks) {
    if (fk.deleteRule !== "a" && fk.deleteRule !== "r") continue;
    const child = tableKey(fk.childSchema, fk.childTable);
    const parent = tableKey(fk.parentSchema, fk.parentTable);
    if (child === parent) continue;
    if (!byTable.has(child) || !byTable.has(parent)) continue;
    const set = dependents.get(parent) ?? new Set<string>();
    if (set.has(child)) continue;
    set.add(child);
    dependents.set(parent, set);
    indegree.set(parent, (indegree.get(parent) ?? 0) + 1);
  }

  // Kahn's algorithm: emit tables with no outstanding children first.
  const queue = [...indegree.entries()].filter(([, n]) => n === 0).map(([k]) => k);
  const ordered: string[] = [];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const key = queue.shift()!;
    if (seen.has(key)) continue;
    seen.add(key);
    ordered.push(key);
    for (const [parent, children] of dependents) {
      if (!children.has(key)) continue;
      children.delete(key);
      const next = (indegree.get(parent) ?? 1) - 1;
      indegree.set(parent, next);
      if (next === 0) queue.push(parent);
    }
  }
  // Anything left is part of a cycle; append it and let the retry loop sort it out.
  for (const key of byTable.keys()) if (!seen.has(key)) ordered.push(key);

  return ordered.flatMap((key) => byTable.get(key) ?? []);
}

/**
 * Create temporary indexes on unindexed foreign key columns pointing at the
 * tables this purge deletes from, and return the DROP statements to undo them.
 *
 * This is the difference between a purge that finishes in a minute and one that
 * runs for hours. 315 of the schema's 616 foreign keys have no index on the
 * child column, and Postgres enforces ON DELETE CASCADE / SET NULL with a
 * per-row trigger: deleting one parent row scans each unindexed child table
 * once. `heartbeat_runs` alone is referenced by 39 unindexed columns, three of
 * them on `issue_comments` (~90k rows), so removing ~11k runs costs hundreds of
 * thousands of sequential scans.
 *
 * The indexes are built inside the purge transaction, so a dry run measures the
 * fast path and leaves nothing behind, and they are dropped again before commit
 * — the schema is not permanently altered by a maintenance command.
 *
 * OPT-IN ONLY (`--fk-indexes`), because CREATE INDEX takes an ACCESS EXCLUSIVE
 * lock on the table and this builds hundreds of them inside one uncommitted
 * transaction. Postgres holds every one of those locks until the transaction
 * ends, so against a running server it stalls all writes to the affected tables
 * for the duration of the purge. Only use it with the service stopped.
 */
async function createHelperIndexes(
  tx: postgres.TransactionSql,
  deleteTargets: Set<string>,
  onProgress: (message: string) => void,
): Promise<string[]> {
  const missing = await tx<
    Array<{ schema: string; table: string; column: string }>
  >`
    SELECT cn.nspname AS schema, cl.relname AS table, ca.attname AS column
    FROM pg_constraint con
    JOIN pg_class cl      ON cl.oid = con.conrelid
    JOIN pg_namespace cn  ON cn.oid = cl.relnamespace
    JOIN pg_class pr      ON pr.oid = con.confrelid
    JOIN pg_namespace pn  ON pn.oid = pr.relnamespace
    JOIN pg_attribute ca  ON ca.attrelid = con.conrelid AND ca.attnum = con.conkey[1]
    WHERE con.contype = 'f'
      AND array_length(con.conkey, 1) = 1
      AND pn.nspname || '.' || pr.relname = ANY(${[...deleteTargets]})
      AND NOT EXISTS (
        SELECT 1 FROM pg_index i
        WHERE i.indrelid = con.conrelid AND i.indkey[0] = con.conkey[1]
      )
  `;

  // One FK column can back several constraints; build each index once.
  const unique = new Map<string, { schema: string; table: string; column: string }>();
  for (const row of missing) {
    unique.set(`${row.schema}.${row.table}.${row.column}`, row);
  }

  const drops: string[] = [];
  let n = 0;
  for (const row of unique.values()) {
    const indexName = `pcpurge_tmp_idx_${n++}`;
    onProgress(`index ${n}/${unique.size} · ${row.table}.${row.column}`);
    await tx.unsafe(
      `CREATE INDEX ${quoteIdent(indexName)} ON ${qualify(row.schema, row.table)} (${quoteIdent(row.column)})`,
    );
    drops.push(`DROP INDEX ${qualify(row.schema, indexName)}`);
  }
  return drops;
}

/**
 * Run every step to completion, discovering a workable order by retry.
 *
 * Each DELETE is wrapped in a SAVEPOINT. An FK violation means "a child of this
 * table has not been deleted yet" — roll back that statement only and try again
 * next pass. Any other error is a real failure and aborts the purge. The loop
 * terminates when a full pass deletes nothing new; anything still pending at
 * that point is reported as an unresolvable cycle rather than forced through.
 */
async function runSteps(
  tx: postgres.TransactionSql,
  steps: PurgeStep[],
  targetIds: string[],
  onProgress: (message: string) => void,
): Promise<void> {
  let pending = [...steps];
  let savepoint = 0;
  let pass = 0;
  let done = 0;

  while (pending.length > 0) {
    const stillPending: PurgeStep[] = [];
    let progressed = false;
    pass += 1;

    for (const step of pending) {
      // Deletes on this schema can be slow: 315 of the database's foreign keys
      // have no index on the child column, so each cascading parent row costs a
      // scan of the child table. Naming the current table makes a long pass
      // legible instead of looking like a hang.
      onProgress(`pass ${pass} · ${done}/${steps.length} · ${step.label}`);
      const name = `purge_sp_${savepoint++}`;
      await tx.unsafe(`SAVEPOINT ${name}`);
      try {
        const result = await tx.unsafe(step.sql, [targetIds as never]);
        await tx.unsafe(`RELEASE SAVEPOINT ${name}`);
        step.deleted = result.count ?? 0;
        progressed = true;
        done += 1;
      } catch (error) {
        await tx.unsafe(`ROLLBACK TO SAVEPOINT ${name}`);
        if ((error as { code?: string }).code !== FK_VIOLATION) throw error;
        stillPending.push(step);
      }
    }

    if (!progressed) {
      const blocked = stillPending.map((s) => s.label).join(", ");
      throw new Error(
        `Purge stalled with ${stillPending.length} table(s) still blocked by foreign keys: ${blocked}. ` +
          `This usually means a reference cycle, or a company that must be purged in the same set.`,
      );
    }

    pending = stillPending;
  }
}

function assertApplyFlags(opts: CompanyPurgeOptions, targets: TargetCompany[]): void {
  if (!opts.yes) {
    throw new Error("--apply requires --yes to confirm this destructive action.");
  }
  const confirm = opts.confirm?.trim();
  if (!confirm) {
    throw new Error(
      "--apply requires --confirm <value> matching a target company ID, prefix, or name.",
    );
  }
  const needle = confirm.toLowerCase();
  const matched = targets.some(
    (t) =>
      t.id.toLowerCase() === needle ||
      t.issuePrefix.toLowerCase() === needle ||
      t.name.toLowerCase() === needle,
  );
  if (!matched) {
    throw new Error(
      `--confirm '${confirm}' does not match any target company. Expected one of: ` +
        targets.map((t) => `${t.name} / ${t.issuePrefix} / ${t.id}`).join(" | "),
    );
  }
}

export async function companyPurgeCommand(
  selectors: string[],
  opts: CompanyPurgeOptions,
): Promise<void> {
  const apply = opts.apply === true;
  const connection = resolveConnectionString(opts.config);
  const sql = postgres(connection.value, { max: 1, onnotice: () => {} });

  if (!opts.json) {
    p.intro(pc.bgRed(pc.black(" paperclip company purge ")));
    p.log.message(pc.dim(`Connection source: ${connection.source}`));
    p.log.message(apply ? pc.red("Mode: APPLY (commits)") : pc.cyan("Mode: dry run (rolls back)"));
  }

  try {
    const targets = await resolveTargets(sql, selectors);
    const targetIds = targets.map((t) => t.id);
    if (apply) assertApplyFlags(opts, targets);

    if (!opts.json) {
      p.log.step("Target companies");
      for (const t of targets) {
        p.log.message(`  ${pc.bold(t.name)} ${pc.dim(`${t.issuePrefix} · ${t.id}`)}`);
      }
    }

    const scopedTables = await discoverScopedTables(sql);
    const scoped = new Set(scopedTables.map((t) => tableKey(t.schema, t.table)));
    const fks = await discoverForeignKeys(sql);

    const dependents = await findExternalDependents(sql, fks, scoped, targetIds);
    if (dependents.length > 0) {
      const detail = dependents.map((d) => `${d.fk} (${d.count} row(s))`).join("; ");
      throw new Error(
        `Refusing to purge: companies outside the target set reference this data — ${detail}. ` +
          `Add the referencing company to the same purge, or clear those references first.`,
      );
    }

    const steps = orderSteps(buildSteps(scopedTables, fks, scoped), fks);
    if (!opts.json) {
      p.log.step(
        `Plan: ${steps.length} delete(s) across ${scopedTables.length} company-scoped table(s)`,
      );
    }

    // Back up before anything that commits. A dry run changes nothing, so it
    // does not need one.
    let backupPath: string | null = null;
    if (apply && opts.backup !== false) {
      const config = readConfig(opts.config);
      const dir = path.resolve(
        expandHomePrefix(
          config?.database.backup.dir || resolveDefaultBackupDir(resolvePaperclipInstanceId()),
        ),
      );
      const spinner = opts.json ? null : p.spinner();
      spinner?.start("Backing up database before purge...");
      const result = await runDatabaseBackup({
        connectionString: connection.value,
        backupDir: dir,
        retention: { dailyDays: 30, weeklyWeeks: 4, monthlyMonths: 1 },
        filenamePrefix: "paperclip-pre-purge",
      });
      backupPath = result.backupFile;
      spinner?.stop(`Backup saved: ${formatDatabaseBackupResult(result)}`);
    }

    let companiesDeleted = 0;
    const spinner = opts.json ? null : p.spinner();
    spinner?.start("Deleting company data...");

    await sql.begin(async (tx) => {
      let dropIndexes: string[] = [];
      if (opts.fkIndexes === true) {
        dropIndexes = await createHelperIndexes(
          tx,
          new Set(steps.map((s) => s.tableKey)),
          (message) => {
            if (opts.json) process.stderr.write(`${message}\n`);
            else spinner?.message(message);
          },
        );
      }

      await runSteps(tx, steps, targetIds, (message) => {
        if (opts.json) process.stderr.write(`${message}\n`);
        else spinner?.message(message);
      });

      const result = await tx.unsafe(`DELETE FROM public.companies WHERE id = ANY($1)`, [
        targetIds as never,
      ]);
      companiesDeleted = result.count ?? 0;

      // Leave the schema exactly as it was found.
      for (const drop of dropIndexes) await tx.unsafe(drop);

      if (!apply) {
        // Everything above succeeded, which is the proof a real purge would
        // work. Undo it.
        throw new DryRunRollback();
      }
    }).catch((error) => {
      if (error instanceof DryRunRollback) return;
      throw error;
    });

    spinner?.stop(apply ? "Purge committed." : "Dry run complete (rolled back).");

    const touched = steps
      .filter((s) => (s.deleted ?? 0) > 0)
      .sort((a, b) => (b.deleted ?? 0) - (a.deleted ?? 0));
    const totalRows = touched.reduce((sum, s) => sum + (s.deleted ?? 0), 0);

    if (opts.json) {
      process.stdout.write(
        `${JSON.stringify(
          {
            ok: true,
            applied: apply,
            backupPath,
            companies: targets,
            companiesDeleted,
            totalRowsDeleted: totalRows,
            tables: touched.map((s) => ({ table: s.label, rows: s.deleted })),
          },
          null,
          2,
        )}\n`,
      );
    } else {
      p.log.step(`Rows ${apply ? "deleted" : "that would be deleted"}: ${totalRows}`);
      for (const step of touched) {
        p.log.message(`  ${String(step.deleted).padStart(8)}  ${step.label}`);
      }
      p.outro(
        apply
          ? pc.green(`Purged ${companiesDeleted} company/companies.`)
          : pc.cyan("Nothing was changed. Re-run with --apply --yes --confirm <id> to commit."),
      );
    }
  } finally {
    await sql.end();
  }
}

/** Sentinel used to unwind the transaction after a successful dry run. */
class DryRunRollback extends Error {
  constructor() {
    super("dry-run rollback");
    this.name = "DryRunRollback";
  }
}

export function registerCompanyPurgeCommand(company: Command): void {
  company
    .command("purge")
    .description(
      "Hard-delete companies and all their data directly in Postgres (dry run by default)",
    )
    .argument("<selectors...>", "Company IDs, issue prefixes, or exact names")
    .option("--config <path>", "Path to the Paperclip config file")
    .option("--apply", "Commit the purge instead of rolling back", false)
    .option("--yes", "Required with --apply to confirm this destructive action", false)
    .option("--confirm <value>", "Required with --apply: a target company ID, prefix, or name")
    .option("--no-backup", "Skip the pre-purge database backup (not recommended)")
    .option(
      "--fk-indexes",
      "Build temporary indexes on unindexed foreign keys first. Much faster, but takes " +
        "ACCESS EXCLUSIVE locks for the whole transaction — only use with the server stopped",
      false,
    )
    .option("--json", "Emit JSON instead of formatted output", false)
    .action(async (selectors: string[], opts: CompanyPurgeOptions) => {
      try {
        await companyPurgeCommand(selectors, opts);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (opts.json) {
          process.stdout.write(`${JSON.stringify({ ok: false, error: message }, null, 2)}\n`);
        } else {
          p.log.error(pc.red(message));
        }
        process.exitCode = 1;
      }
    });
}
