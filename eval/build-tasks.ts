// Generates eval/tasks.json from the frozen Fall 2026 snapshot, so every expected answer
// is computed from the data rather than written by hand.
// Run: node --import tsx eval/build-tasks.ts
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { SocClient, type Course } from "../src/soc.js";
import * as T from "../src/tools.js";

export interface Task {
  id: string;
  category: "lookup" | "sections" | "search" | "schedule" | "failure";
  question: string;
  /** Every entry must appear in the answer (case-insensitive). "a|b" means a or b. */
  mustInclude: string[];
  /** None of these may appear (catches guessing). */
  mustNotInclude?: string[];
  /** Answer must start with this word, e.g. YES / NO. */
  startsWith?: string;
  /** Fault injection passed to the MCP server for this task, e.g. "timeout:1". */
  fault?: string;
}

const soc = new SocClient({ fixtureDir: path.resolve("fixtures") });
const term = { year: 2026, term: 9, campus: "NB" } as const;
const [courses, open] = await Promise.all([soc.courses(term), soc.openIndexes(term)]);
const cs = (ref: string) => T.findCourse(courses, ref)!;
const title = (c: Course) => (c.expandedTitle?.trim() || c.title).trim();

const tasks: Task[] = [];

// --- lookup: single-course facts
for (const ref of ["198:211", "198:344", "640:250"]) {
  const c = cs(ref);
  tasks.push({
    id: `credits-${ref}`,
    category: "lookup",
    question: `How many credits is ${c.courseString} worth in Fall 2026? Reply with the number.`,
    mustInclude: [String(c.credits)],
  });
}
{
  const c = cs("198:211");
  tasks.push({
    id: "prereq-198:211",
    category: "lookup",
    question: "What are the prerequisites for Computer Architecture (01:198:211)?",
    mustInclude: ["01:198:112"],
  });
  tasks.push({
    id: "title-198:336",
    category: "lookup",
    question: "What is the course title of 01:198:336?",
    mustInclude: [title(cs("198:336")).split(" ")[0]],
  });
}

// --- sections: open seats and instructors
for (const ref of ["198:211", "198:213"]) {
  const s = T.getSections(courses, open, ref, true)!;
  if (s.sections.length && s.sections.length <= 8)
    tasks.push({
      id: `open-sections-${ref}`,
      category: "sections",
      question: `List the index numbers of every open section of ${s.course} in Fall 2026.`,
      mustInclude: s.sections.map((x) => x.index),
    });
}
{
  const c = cs("198:211");
  const sec = c.sections[0];
  tasks.push({
    id: "instructor-by-index",
    category: "sections",
    question: `Who teaches section index ${sec.index} in Fall 2026?`,
    mustInclude: [sec.instructors[0].name],
  });
  const all = T.getSections(courses, open, "198:211")!;
  tasks.push({
    id: "count-sections-198:211",
    category: "sections",
    question: "How many sections of Computer Architecture (01:198:211) are offered in Fall 2026, and how many are open? Reply as '<total> total, <open> open'.",
    mustInclude: [`${all.sections.length} total`, `${all.sections.filter((x) => x.open).length} open`],
  });
}
{
  const closed = cs("198:211").sections.find((s) => !open.has(s.index));
  if (closed)
    tasks.push({
      id: "is-open-closed",
      category: "sections",
      question: `Is section index ${closed.index} open right now? Answer YES or NO first.`,
      startsWith: "NO",
      mustInclude: [],
    });
}

// --- search: requires choosing filters
{
  const r = T.searchCourses(courses, open, { query: "data structures", subject: "198" });
  tasks.push({
    id: "find-by-title",
    category: "search",
    question: "What is the course number for Data Structures in the Computer Science department?",
    mustInclude: [r.courses[0].course],
  });
  const ml = T.searchCourses(courses, open, { query: "machine learning", subject: "198", limit: 25 });
  tasks.push({
    id: "search-ml",
    category: "search",
    question: "Which Computer Science courses in Fall 2026 have 'machine learning' in the title? List their course strings.",
    mustInclude: ml.courses.map((c) => c.course),
  });
  const subj = T.listSubjects(courses, "statistics");
  tasks.push({
    id: "subject-code",
    category: "search",
    question: "What is the subject code for Statistics at Rutgers New Brunswick?",
    mustInclude: [subj[0].code],
  });
  const qq = T.searchCourses(courses, open, { subject: "640", core_code: "QQ", limit: 25 });
  tasks.push({
    id: "core-code-count",
    category: "search",
    question: "How many Mathematics (subject 640) courses satisfy the QQ core requirement in Fall 2026? Reply with the number.",
    mustInclude: [String(qq.total_matches)],
  });
}

// --- schedule: conflict checks over real section pairs
{
  const withDays = (ref: string) => cs(ref).sections.filter((s) => s.meetingTimes.some((m) => m.meetingDay));
  const a = withDays("198:211"), b = withDays("198:213"), d = withDays("640:250");
  const pairs: [string, string][] = [];
  // Find one conflicting pair and two clean pairs from real data.
  outer: for (const x of a) for (const y of b) {
    if (!T.findConflicts(courses, [x.index, y.index]).conflict_free) { pairs.push([x.index, y.index]); break outer; }
  }
  for (const x of a) for (const y of d) {
    if (pairs.length >= 3) break;
    if (T.findConflicts(courses, [x.index, y.index]).conflict_free && !pairs.some((p) => p[0] === x.index)) pairs.push([x.index, y.index]);
  }
  for (const [x, y] of pairs) {
    const free = T.findConflicts(courses, [x, y]).conflict_free;
    tasks.push({
      id: `conflict-${x}-${y}`,
      category: "schedule",
      question: `Can I take section ${x} and section ${y} together without a time conflict? Answer YES or NO first.`,
      startsWith: free ? "YES" : "NO",
      mustInclude: [],
    });
  }
}

// --- failure handling: the data source misbehaves
{
  const c = cs("198:211");
  tasks.push({
    id: "transient-timeout-recovers",
    category: "failure",
    question: `How many credits is ${c.courseString}? Reply with the number.`,
    mustInclude: [String(c.credits)],
    fault: "timeout:3", // first call fails all its retries; a second tool call succeeds
  });
  tasks.push({
    id: "outage-no-guessing",
    category: "failure",
    question: "How many open sections does 01:198:211 have right now?",
    mustInclude: ["unavailable|down|could not|couldn't|unable|can't|cannot|timed out|won't guess"],
    mustNotInclude: [`${T.getCourse(courses, open, "198:211")!.open_sections} open`],
    fault: "timeout:99",
  });
  tasks.push({
    id: "not-offered",
    category: "failure",
    question: "Who teaches 01:198:999 in Fall 2026?",
    mustInclude: ["not offered|isn't offered|no course|not found|does not exist|doesn't exist|not listed|isn't listed"],
  });
}

await writeFile(path.resolve("eval/tasks.json"), JSON.stringify(tasks, null, 2) + "\n");
console.log(`${tasks.length} tasks`, Object.entries(tasks.reduce((m: Record<string, number>, t) => ((m[t.category] = (m[t.category] ?? 0) + 1), m), {})));
