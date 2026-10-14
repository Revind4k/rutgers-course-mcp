// Client for the public Rutgers Schedule of Classes (SOC) API.
// Two endpoints: the full course list for a term, and the live list of open section indexes.
import { readFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import path from "node:path";

const BASE = "https://classes.rutgers.edu/soc/api";

export interface Term {
  year: number;
  /** 0 = winter, 1 = spring, 7 = summer, 9 = fall */
  term: 0 | 1 | 7 | 9;
  campus: "NB" | "NK" | "CM";
}

export interface MeetingTime {
  meetingDay: string; // M T W H F S U, or "" for online/by-arrangement
  startTimeMilitary: string; // "1930"
  endTimeMilitary: string;
  campusName: string;
  buildingCode: string;
  roomNumber: string;
  meetingModeDesc: string; // LEC, RECIT, LAB, ONLINE INSTRUCTION(INTERNET) ...
}

export interface Section {
  index: string;
  number: string;
  openStatus: boolean;
  instructors: { name: string }[];
  meetingTimes: MeetingTime[];
  sectionNotes?: string;
}

export interface Course {
  courseString: string; // "01:198:211"
  title: string;
  expandedTitle?: string;
  subject: string;
  subjectDescription: string;
  courseNumber: string;
  credits: number | null;
  level: string; // U or G
  preReqNotes: string;
  courseDescription?: string;
  coreCodes: { coreCode: string; coreCodeDescription: string }[];
  sections: Section[];
}

export type SocErrorKind = "timeout" | "http" | "network" | "parse";

export class SocError extends Error {
  constructor(
    public kind: SocErrorKind,
    message: string,
  ) {
    super(message);
    this.name = "SocError";
  }
}

export interface SocOptions {
  /** Read gzipped snapshots from this directory instead of the network (tests, evals). */
  fixtureDir?: string;
  timeoutMs?: number;
  retries?: number;
  /** Fault injection for testing: fail the first N fetches with this error kind. */
  fault?: { kind: SocErrorKind; times: number };
  cacheTtlMs?: number;
}

const termKey = (t: Term) => `${t.year}-${t.term}-${t.campus}`;

export class SocClient {
  private courseCache = new Map<string, { at: number; data: Course[] }>();
  private faultsLeft: number;

  constructor(private opts: SocOptions = {}) {
    this.faultsLeft = opts.fault?.times ?? 0;
  }

  static fromEnv(): SocClient {
    const fault = process.env.SOC_FAULT; // e.g. "timeout:1"
    return new SocClient({
      fixtureDir: process.env.SOC_FIXTURE_DIR,
      fault: fault
        ? { kind: fault.split(":")[0] as SocErrorKind, times: Number(fault.split(":")[1] ?? 1) }
        : undefined,
    });
  }

  async courses(t: Term): Promise<Course[]> {
    const key = termKey(t);
    const hit = this.courseCache.get(key);
    if (hit && Date.now() - hit.at < (this.opts.cacheTtlMs ?? 60 * 60 * 1000)) return hit.data;
    const data = (await this.get(`courses-${key}`, `/courses.json?year=${t.year}&term=${t.term}&campus=${t.campus}`)) as Course[];
    this.courseCache.set(key, { at: Date.now(), data });
    return data;
  }

  /** Live: never cached, because seats open and close all day. */
  async openIndexes(t: Term): Promise<Set<string>> {
    const key = termKey(t);
    const data = (await this.get(`open-${key}`, `/openSections.json?year=${t.year}&term=${t.term}&campus=${t.campus}`)) as string[];
    return new Set(data);
  }

  private async get(fixtureName: string, urlPath: string): Promise<unknown> {
    const retries = this.opts.retries ?? 2;
    let last: SocError | undefined;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        return await this.once(fixtureName, urlPath);
      } catch (err) {
        last = err instanceof SocError ? err : new SocError("network", String(err));
        // A 4xx will not fix itself; everything else is worth another try.
        if (last.kind === "http" && /^4/.test(last.message)) break;
        if (attempt < retries) await new Promise((r) => setTimeout(r, 250 * 2 ** attempt));
      }
    }
    throw last!;
  }

  private async once(fixtureName: string, urlPath: string): Promise<unknown> {
    if (this.faultsLeft > 0) {
      this.faultsLeft--;
      throw new SocError(this.opts.fault!.kind, `injected ${this.opts.fault!.kind}`);
    }
    if (this.opts.fixtureDir) {
      const buf = await readFile(path.join(this.opts.fixtureDir, `${fixtureName}.json.gz`));
      return JSON.parse(gunzipSync(buf).toString("utf8"));
    }
    let res: Response;
    try {
      res = await fetch(BASE + urlPath, { signal: AbortSignal.timeout(this.opts.timeoutMs ?? 20_000) });
    } catch (err) {
      const name = (err as Error).name;
      throw new SocError(name === "TimeoutError" || name === "AbortError" ? "timeout" : "network", String(err));
    }
    if (!res.ok) throw new SocError("http", `${res.status} ${res.statusText}`);
    try {
      return await res.json();
    } catch (err) {
      throw new SocError("parse", String(err));
    }
  }
}
