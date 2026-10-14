// Tool logic as pure functions over SOC data, so it can be unit-tested without MCP or the network.
import type { Course, MeetingTime, Section } from "./soc.js";

const DAY: Record<string, string> = { M: "Mon", T: "Tue", W: "Wed", H: "Thu", F: "Fri", S: "Sat", U: "Sun" };

const stripHtml = (s: string) => s.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();

const fmtTime = (mil: string) => {
  const h = Number(mil.slice(0, 2));
  const m = mil.slice(2);
  return `${((h + 11) % 12) + 1}:${m}${h < 12 ? "am" : "pm"}`;
};

export const fmtMeeting = (m: MeetingTime) =>
  m.meetingDay
    ? `${DAY[m.meetingDay] ?? m.meetingDay} ${fmtTime(m.startTimeMilitary)}-${fmtTime(m.endTimeMilitary)} ${m.meetingModeDesc} ${m.campusName} ${m.buildingCode}-${m.roomNumber}`.trim()
    : `${m.meetingModeDesc || "By arrangement"} (no fixed time)`;

/** Accepts "01:198:211", "198:211" or "198211"; returns the matching course or undefined. */
export function findCourse(courses: Course[], ref: string): Course | undefined {
  const digits = ref.replace(/[^0-9]/g, "");
  const want = digits.slice(-6);
  const unit = digits.length >= 8 ? digits.slice(0, 2) : undefined;
  return courses.find(
    (c) => c.subject + c.courseNumber === want && (!unit || c.courseString.startsWith(unit + ":")),
  );
}

export interface SearchArgs {
  query?: string;
  subject?: string;
  core_code?: string;
  level?: "U" | "G";
  open_only?: boolean;
  limit?: number;
}

export function searchCourses(courses: Course[], open: Set<string>, a: SearchArgs) {
  const q = a.query?.toLowerCase().split(/\s+/).filter(Boolean) ?? [];
  const hits = courses.filter((c) => {
    if (a.subject && c.subject !== a.subject.padStart(3, "0")) return false;
    if (a.level && c.level !== a.level) return false;
    if (a.core_code && !c.coreCodes.some((k) => k.coreCode.toUpperCase() === a.core_code!.toUpperCase())) return false;
    if (a.open_only && !c.sections.some((s) => open.has(s.index))) return false;
    if (q.length) {
      const hay = `${c.title} ${c.expandedTitle ?? ""} ${c.subjectDescription} ${c.courseString}`.toLowerCase();
      if (!q.every((w) => hay.includes(w))) return false;
    }
    return true;
  });
  const limit = Math.min(a.limit ?? 10, 25);
  return {
    total_matches: hits.length,
    courses: hits.slice(0, limit).map((c) => ({
      course: c.courseString,
      title: (c.expandedTitle?.trim() || c.title).trim(),
      credits: c.credits,
      sections: c.sections.length,
      open_sections: c.sections.filter((s) => open.has(s.index)).length,
    })),
  };
}

export function getCourse(courses: Course[], open: Set<string>, ref: string) {
  const c = findCourse(courses, ref);
  if (!c) return null;
  return {
    course: c.courseString,
    title: (c.expandedTitle?.trim() || c.title).trim(),
    subject: `${c.subject} ${c.subjectDescription}`,
    credits: c.credits,
    level: c.level === "G" ? "graduate" : "undergraduate",
    prerequisites: stripHtml(c.preReqNotes || "") || "none listed",
    core_codes: c.coreCodes.map((k) => `${k.coreCode} (${k.coreCodeDescription})`),
    sections: c.sections.length,
    open_sections: c.sections.filter((s) => open.has(s.index)).length,
  };
}

const sectionView = (s: Section, open: Set<string>) => ({
  index: s.index,
  section: s.number,
  open: open.has(s.index),
  instructors: s.instructors.map((i) => i.name),
  meetings: s.meetingTimes.map(fmtMeeting),
});

export function getSections(courses: Course[], open: Set<string>, ref: string, openOnly = false) {
  const c = findCourse(courses, ref);
  if (!c) return null;
  const secs = c.sections.filter((s) => !openOnly || open.has(s.index)).map((s) => sectionView(s, open));
  return { course: c.courseString, title: (c.expandedTitle?.trim() || c.title).trim(), sections: secs };
}

export function sectionsByIndex(courses: Course[]) {
  const map = new Map<string, { course: Course; section: Section }>();
  for (const c of courses) for (const s of c.sections) map.set(s.index, { course: c, section: s });
  return map;
}

export function checkOpen(courses: Course[], open: Set<string>, indexes: string[]) {
  const byIdx = sectionsByIndex(courses);
  return indexes.map((i) => {
    const hit = byIdx.get(i);
    return hit
      ? { index: i, course: hit.course.courseString, section: hit.section.number, open: open.has(i) }
      : { index: i, error: "no section with this index this term" };
  });
}

const toMin = (mil: string) => Number(mil.slice(0, 2)) * 60 + Number(mil.slice(2));

/** Pairwise time overlaps between sections. Meetings with no fixed day never conflict. */
export function findConflicts(courses: Course[], indexes: string[]) {
  const byIdx = sectionsByIndex(courses);
  const unknown = indexes.filter((i) => !byIdx.has(i));
  const known = indexes.filter((i) => byIdx.has(i));
  const conflicts: { a: string; b: string; day: string; overlap: string }[] = [];
  for (let x = 0; x < known.length; x++)
    for (let y = x + 1; y < known.length; y++) {
      const A = byIdx.get(known[x])!, B = byIdx.get(known[y])!;
      for (const ma of A.section.meetingTimes)
        for (const mb of B.section.meetingTimes) {
          if (!ma.meetingDay || ma.meetingDay !== mb.meetingDay) continue;
          const start = Math.max(toMin(ma.startTimeMilitary), toMin(mb.startTimeMilitary));
          const end = Math.min(toMin(ma.endTimeMilitary), toMin(mb.endTimeMilitary));
          if (start < end)
            conflicts.push({
              a: `${known[x]} (${A.course.courseString})`,
              b: `${known[y]} (${B.course.courseString})`,
              day: DAY[ma.meetingDay] ?? ma.meetingDay,
              overlap: `${end - start} min`,
            });
        }
    }
  return { conflict_free: conflicts.length === 0 && unknown.length === 0, conflicts, unknown_indexes: unknown };
}

export function listSubjects(courses: Course[], query?: string) {
  const seen = new Map<string, string>();
  for (const c of courses) seen.set(c.subject, c.subjectDescription);
  const q = query?.toLowerCase();
  return [...seen]
    .filter(([code, name]) => !q || name.toLowerCase().includes(q) || code === q.padStart(3, "0"))
    .sort()
    .map(([code, name]) => ({ code, name }));
}
