import { describe, expect, it } from "vitest";
import type { LiveRunForIssue } from "../api/heartbeats";
import { markRunTerminalInList, patchRunStatusInList, removeRunFromList } from "./live-runs-cache";

function run(id: string, status: string): LiveRunForIssue {
  return {
    id,
    status,
    invocationSource: "automation",
    triggerDetail: null,
    startedAt: null,
    finishedAt: null,
    createdAt: "2026-07-15T00:00:00.000Z",
    agentId: "agent-1",
    agentName: "Agent One",
    adapterType: "codex_local",
  };
}

describe("removeRunFromList", () => {
  it("removes the matching run", () => {
    const list = [run("a", "running"), run("b", "running")];
    expect(removeRunFromList(list, "a")).toEqual([run("b", "running")]);
  });

  it("returns the same reference when the run isn't present", () => {
    const list = [run("a", "running")];
    expect(removeRunFromList(list, "zzz")).toBe(list);
  });

  it("handles undefined", () => {
    expect(removeRunFromList(undefined, "a")).toBeUndefined();
  });
});

describe("patchRunStatusInList", () => {
  it("updates status in place and reports present", () => {
    const list = [run("a", "queued"), run("b", "running")];
    const { next, present } = patchRunStatusInList(list, "a", "running");
    expect(present).toBe(true);
    expect(next?.find((r) => r.id === "a")?.status).toBe("running");
    expect(next?.find((r) => r.id === "b")).toBe(list[1]); // untouched entry kept by ref
  });

  it("returns the same reference and present=false when the run isn't in the list", () => {
    const list = [run("a", "running")];
    const { next, present } = patchRunStatusInList(list, "new", "running");
    expect(present).toBe(false);
    expect(next).toBe(list);
  });

  it("returns the same reference (no re-render) when status is unchanged", () => {
    const list = [run("a", "running")];
    const { next, present } = patchRunStatusInList(list, "a", "running");
    expect(present).toBe(true);
    expect(next).toBe(list); // unchanged → original reference preserved
  });

  it("handles undefined", () => {
    const { next, present } = patchRunStatusInList(undefined, "a", "running");
    expect(present).toBe(false);
    expect(next).toBeUndefined();
  });
});

describe("markRunTerminalInList", () => {
  it("keeps the run and sets the terminal status and finishedAt", () => {
    const list = [run("a", "running"), run("b", "running")];
    const next = markRunTerminalInList(list, "a", "succeeded", "2026-07-24T10:00:00.000Z");
    expect(next).toHaveLength(2);
    expect(next?.[0]).toEqual({ ...run("a", "running"), status: "succeeded", finishedAt: "2026-07-24T10:00:00.000Z" });
    expect(next?.[1]).toBe(list[1]); // untouched entry kept by ref
  });

  it("keeps an existing finishedAt when the event carries none", () => {
    const list = [{ ...run("a", "running"), finishedAt: "2026-07-24T09:00:00.000Z" }];
    const next = markRunTerminalInList(list, "a", "failed", null);
    expect(next?.[0]).toEqual({ ...list[0], status: "failed" });
  });

  it("returns the same reference when the run isn't present or is already terminal", () => {
    const list = [{ ...run("a", "succeeded"), finishedAt: "2026-07-24T10:00:00.000Z" }];
    expect(markRunTerminalInList(list, "zzz", "succeeded", null)).toBe(list);
    expect(markRunTerminalInList(list, "a", "succeeded", "2026-07-24T10:00:00.000Z")).toBe(list);
  });

  it("handles undefined", () => {
    expect(markRunTerminalInList(undefined, "a", "succeeded", null)).toBeUndefined();
  });
});
