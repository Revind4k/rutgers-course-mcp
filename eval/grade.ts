// Programmatic grading: no LLM judge, so scores are deterministic and free to recompute.
import type { Task } from "./build-tasks.js";

/** Numbers must match as whole tokens, so "4" does not match inside "01:198:344". */
export function includes(answer: string, needle: string): boolean {
  return needle.split("|").some((alt) => {
    const a = alt.toLowerCase();
    if (/^\d+$/.test(a)) return new RegExp(`(?<![\\d:])${a}(?![\\d:])`).test(answer.toLowerCase());
    return answer.toLowerCase().includes(a);
  });
}

export function grade(t: Task, answer: string): { pass: boolean; why: string[] } {
  const why: string[] = [];
  for (const m of t.mustInclude) if (!includes(answer, m)) why.push(`missing "${m}"`);
  for (const m of t.mustNotInclude ?? []) if (includes(answer, m)) why.push(`contains forbidden "${m}"`);
  if (t.startsWith && !answer.trim().toUpperCase().replace(/^[*_#\s]+/, "").startsWith(t.startsWith)) why.push(`does not start with ${t.startsWith}`);
  return { pass: why.length === 0, why };
}
