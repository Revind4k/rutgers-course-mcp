// MCP server (stdio) exposing the Rutgers Schedule of Classes as tools.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { SocClient, SocError, type Term } from "./soc.js";
import * as T from "./tools.js";

const DEFAULT_TERM: Term = { year: 2026, term: 9, campus: "NB" };

const termShape = {
  year: z.number().int().min(2020).max(2030).optional().describe("Defaults to 2026"),
  term: z.union([z.literal(0), z.literal(1), z.literal(7), z.literal(9)]).optional()
    .describe("0 winter, 1 spring, 7 summer, 9 fall. Defaults to 9 (Fall 2026)"),
  campus: z.enum(["NB", "NK", "CM"]).optional().describe("NB New Brunswick (default), NK Newark, CM Camden"),
};

const termOf = (a: { year?: number; term?: 0 | 1 | 7 | 9; campus?: "NB" | "NK" | "CM" }): Term => ({
  year: a.year ?? DEFAULT_TERM.year,
  term: a.term ?? DEFAULT_TERM.term,
  campus: a.campus ?? DEFAULT_TERM.campus,
});

const ok = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data) }] });
const fail = (message: string) => ({ content: [{ type: "text" as const, text: message }], isError: true });

export function buildServer(soc = SocClient.fromEnv()) {
  const server = new McpServer({ name: "rutgers-course-mcp", version: "0.1.0" });

  // Every tool goes through this wrapper so upstream failures come back as a tool error
  // the model can reason about (retry, tell the user) instead of crashing the session.
  const guard = <A>(fn: (a: A) => Promise<ReturnType<typeof ok> | ReturnType<typeof fail>>) => async (a: A) => {
    try {
      return await fn(a);
    } catch (err) {
      if (err instanceof SocError)
        return fail(`Rutgers SOC API ${err.kind} error after retries: ${err.message}. The data source may be temporarily down; you can call the tool again.`);
      return fail(`unexpected error: ${String(err)}`);
    }
  };

  server.registerTool(
    "search_courses",
    {
      description:
        "Search the Rutgers course catalog for a term. Filter by keywords in the title, subject code (e.g. '198' for Computer Science), core curriculum code (e.g. 'QQ', 'WCr'), level, or open seats. Returns at most 25 courses plus the total match count.",
      inputSchema: {
        query: z.string().optional().describe("Keywords that must all appear in the title or subject name"),
        subject: z.string().optional().describe("3-digit subject code, e.g. '198'"),
        core_code: z.string().optional(),
        level: z.enum(["U", "G"]).optional(),
        open_only: z.boolean().optional().describe("Only courses with at least one open section"),
        limit: z.number().int().min(1).max(25).optional(),
        ...termShape,
      },
    },
    guard(async (a) => {
      const t = termOf(a);
      const [courses, open] = await Promise.all([soc.courses(t), soc.openIndexes(t)]);
      return ok(T.searchCourses(courses, open, a));
    }),
  );

  server.registerTool(
    "get_course",
    {
      description: "Details for one course: title, credits, prerequisites, core codes, and how many sections are open. Course can be written '01:198:211', '198:211' or '198211'.",
      inputSchema: { course: z.string(), ...termShape },
    },
    guard(async (a) => {
      const t = termOf(a);
      const [courses, open] = await Promise.all([soc.courses(t), soc.openIndexes(t)]);
      return ok(T.getCourse(courses, open, a.course) ?? { error: `no course ${a.course} offered this term` });
    }),
  );

  server.registerTool(
    "get_sections",
    {
      description: "All sections of a course with index number, open/closed status, instructors and meeting times.",
      inputSchema: { course: z.string(), open_only: z.boolean().optional(), ...termShape },
    },
    guard(async (a) => {
      const t = termOf(a);
      const [courses, open] = await Promise.all([soc.courses(t), soc.openIndexes(t)]);
      return ok(T.getSections(courses, open, a.course, a.open_only) ?? { error: `no course ${a.course} offered this term` });
    }),
  );

  server.registerTool(
    "check_open",
    {
      description: "Live open/closed status for specific section index numbers (5-digit, e.g. '11548').",
      inputSchema: { indexes: z.array(z.string()).min(1).max(50), ...termShape },
    },
    guard(async (a) => {
      const t = termOf(a);
      const [courses, open] = await Promise.all([soc.courses(t), soc.openIndexes(t)]);
      return ok(T.checkOpen(courses, open, a.indexes));
    }),
  );

  server.registerTool(
    "find_conflicts",
    {
      description: "Check a set of section index numbers for meeting-time overlaps. Returns every overlapping pair.",
      inputSchema: { indexes: z.array(z.string()).min(2).max(12), ...termShape },
    },
    guard(async (a) => ok(T.findConflicts(await soc.courses(termOf(a)), a.indexes))),
  );

  server.registerTool(
    "list_subjects",
    {
      description: "List subject codes and names, optionally filtered by a name fragment (e.g. 'computer').",
      inputSchema: { query: z.string().optional(), ...termShape },
    },
    guard(async (a) => ok(T.listSubjects(await soc.courses(termOf(a)), a.query))),
  );

  return server;
}

// Run as a stdio server when executed directly.
if (import.meta.url === `file://${process.argv[1]}`) {
  await buildServer().connect(new StdioServerTransport());
}
