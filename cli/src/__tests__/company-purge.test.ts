import { describe, expect, it } from "vitest";
import {
  buildSteps,
  orderSteps,
  type ForeignKey,
  type PurgeStep,
} from "../commands/company-purge.js";

function fk(
  child: string,
  childColumn: string,
  parent: string,
  deleteRule: string,
): ForeignKey {
  const [childSchema, childTable] = child.split(".");
  const [parentSchema, parentTable] = parent.split(".");
  return {
    name: `${childTable}_${childColumn}_fkey`,
    childSchema: childSchema!,
    childTable: childTable!,
    childColumn,
    parentSchema: parentSchema!,
    parentTable: parentTable!,
    parentColumn: "id",
    deleteRule,
  };
}

function scopedSet(tables: string[]): Set<string> {
  return new Set(tables);
}

function toTables(tables: string[]): Array<{ schema: string; table: string }> {
  return tables.map((key) => {
    const [schema, table] = key.split(".");
    return { schema: schema!, table: table! };
  });
}

function order(steps: PurgeStep[]): string[] {
  return steps.map((step) => step.tableKey);
}

describe("buildSteps", () => {
  it("emits one company_id delete per company-scoped table", () => {
    const steps = buildSteps(toTables(["public.issues"]), [], scopedSet(["public.issues"]));
    expect(steps).toHaveLength(1);
    expect(steps[0]!.sql).toContain('DELETE FROM "public"."issues"');
    expect(steps[0]!.sql).toContain("company_id = ANY($1)");
  });

  it("join-deletes NO ACTION children that have no company_id of their own", () => {
    const steps = buildSteps(
      toTables(["public.issues"]),
      [fk("public.decision_effect_executions", "issue_id", "public.issues", "a")],
      scopedSet(["public.issues"]),
    );
    const joined = steps.find((s) => s.tableKey === "public.decision_effect_executions");
    expect(joined).toBeDefined();
    expect(joined!.sql).toContain('USING "public"."issues" pa');
    expect(joined!.sql).toContain("pa.company_id = ANY($1)");
  });

  it("leaves CASCADE and SET NULL children to Postgres", () => {
    // status_card_updates -> issues is SET NULL: deleting those rows would
    // destroy records that merely mention the company rather than belong to it.
    const steps = buildSteps(
      toTables(["public.issues"]),
      [
        fk("public.status_card_updates", "issue_id", "public.issues", "n"),
        fk("public.issue_documents", "issue_id", "public.issues", "c"),
      ],
      scopedSet(["public.issues"]),
    );
    expect(order(steps)).toEqual(["public.issues"]);
  });

  it("keys join-deletes against companies on id rather than company_id", () => {
    const steps = buildSteps(
      [],
      [fk("public.cli_auth_challenges", "company_id", "public.companies", "a")],
      scopedSet([]),
    );
    expect(steps).toHaveLength(1);
    expect(steps[0]!.sql).toContain("pa.id = ANY($1)");
  });

  it("covers plugin schemas the same way as public", () => {
    const steps = buildSteps(
      toTables(["plugin_llm_wiki_8f50.wiki_pages"]),
      [],
      scopedSet(["plugin_llm_wiki_8f50.wiki_pages"]),
    );
    expect(steps[0]!.sql).toContain('DELETE FROM "plugin_llm_wiki_8f50"."wiki_pages"');
  });
});

describe("orderSteps", () => {
  it("places restrictive children before the table they reference", () => {
    // The exact bug in the API's delete: cost_events.heartbeat_run_id is
    // NO ACTION, so heartbeat_runs must not be deleted first.
    const scoped = scopedSet(["public.cost_events", "public.heartbeat_runs"]);
    const fks = [fk("public.cost_events", "heartbeat_run_id", "public.heartbeat_runs", "a")];
    const steps = orderSteps(
      buildSteps(toTables(["public.heartbeat_runs", "public.cost_events"]), fks, scoped),
      fks,
    );
    expect(order(steps)).toEqual(["public.cost_events", "public.heartbeat_runs"]);
  });

  it("ignores CASCADE edges when ordering", () => {
    // CASCADE cannot raise a violation, so it must not constrain the order.
    const scoped = scopedSet(["public.issue_documents", "public.issues"]);
    const fks = [fk("public.issue_documents", "issue_id", "public.issues", "c")];
    const steps = orderSteps(
      buildSteps(toTables(["public.issues", "public.issue_documents"]), fks, scoped),
      fks,
    );
    expect(order(steps)).toEqual(["public.issues", "public.issue_documents"]);
  });

  it("orders a multi-level restrictive chain leaf-first", () => {
    const tables = ["public.a", "public.b", "public.c"];
    const scoped = scopedSet(tables);
    const fks = [
      fk("public.c", "b_id", "public.b", "a"),
      fk("public.b", "a_id", "public.a", "a"),
    ];
    const steps = orderSteps(buildSteps(toTables(tables), fks, scoped), fks);
    expect(order(steps)).toEqual(["public.c", "public.b", "public.a"]);
  });

  it("keeps every step when a cycle cannot be ordered", () => {
    // Cycles are deliberately left for the savepoint retry loop rather than
    // broken here, but no step may be dropped on the way through.
    const tables = ["public.x", "public.y"];
    const scoped = scopedSet(tables);
    const fks = [
      fk("public.x", "y_id", "public.y", "a"),
      fk("public.y", "x_id", "public.x", "a"),
    ];
    const steps = orderSteps(buildSteps(toTables(tables), fks, scoped), fks);
    expect(order(steps).sort()).toEqual(["public.x", "public.y"]);
  });

  it("tolerates self-referencing tables", () => {
    const scoped = scopedSet(["public.issues"]);
    const fks = [fk("public.issues", "parent_id", "public.issues", "a")];
    const steps = orderSteps(buildSteps(toTables(["public.issues"]), fks, scoped), fks);
    expect(order(steps)).toEqual(["public.issues"]);
  });
});
