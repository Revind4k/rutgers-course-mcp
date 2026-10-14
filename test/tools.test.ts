import { describe, expect, it, beforeAll } from "vitest";
import path from "node:path";
import { SocClient, SocError, type Course } from "../src/soc.js";
import * as T from "../src/tools.js";

const fixtureDir = path.resolve("fixtures");
const term = { year: 2026, term: 9, campus: "NB" } as const;
let courses: Course[];
let open: Set<string>;

beforeAll(async () => {
  const soc = new SocClient({ fixtureDir });
  [courses, open] = await Promise.all([soc.courses(term), soc.openIndexes(term)]);
});

describe("findCourse", () => {
  it("accepts every common way of writing a course", () => {
    for (const ref of ["01:198:211", "198:211", "198211", "01 198 211"])
      expect(T.findCourse(courses, ref)?.courseString).toBe("01:198:211");
  });
  it("returns undefined for a course not offered", () => {
    expect(T.findCourse(courses, "198:999")).toBeUndefined();
  });
});

describe("getCourse", () => {
  it("strips HTML from prerequisites", () => {
    const c = T.getCourse(courses, open, "198:211")!;
    expect(c.title).toMatch(/COMPUTER ARCHITECTUR/);
    expect(c.prerequisites).not.toMatch(/<em>/);
    expect(c.prerequisites).toContain("01:198:112");
  });
});

describe("searchCourses", () => {
  it("filters by subject and caps the page at 25", () => {
    const r = T.searchCourses(courses, open, { subject: "198", limit: 100 });
    expect(r.total_matches).toBeGreaterThan(25);
    expect(r.courses).toHaveLength(25);
    expect(r.courses.every((c) => c.course.includes(":198:"))).toBe(true);
  });
  it("open_only never returns a course with zero open sections", () => {
    const r = T.searchCourses(courses, open, { subject: "198", open_only: true, limit: 25 });
    expect(r.courses.every((c) => c.open_sections > 0)).toBe(true);
  });
});

describe("findConflicts", () => {
  it("flags two sections that meet at the same time", () => {
    // Two sections of the same course often share a lecture slot; find a real overlapping pair.
    const c = T.findCourse(courses, "198:211")!;
    const lec = c.sections.filter((s) => s.meetingTimes.some((m) => m.meetingDay));
    const r = T.findConflicts(courses, [lec[0].index, lec[1].index]);
    const sameSlot = lec[0].meetingTimes.some((a) =>
      lec[1].meetingTimes.some((b) => a.meetingDay && a.meetingDay === b.meetingDay && a.startTimeMilitary === b.startTimeMilitary));
    expect(r.conflict_free).toBe(!sameSlot);
  });
  it("reports unknown indexes instead of silently passing", () => {
    const r = T.findConflicts(courses, ["00000", "99999"]);
    expect(r.conflict_free).toBe(false);
    expect(r.unknown_indexes).toEqual(["00000", "99999"]);
  });
});

describe("SocClient fault handling", () => {
  it("retries past a transient timeout", async () => {
    const soc = new SocClient({ fixtureDir, fault: { kind: "timeout", times: 1 }, retries: 2 });
    await expect(soc.openIndexes(term)).resolves.toBeInstanceOf(Set);
  });
  it("gives up with a typed error after the retry budget", async () => {
    const soc = new SocClient({ fixtureDir, fault: { kind: "timeout", times: 5 }, retries: 2 });
    await expect(soc.openIndexes(term)).rejects.toBeInstanceOf(SocError);
  });
});
