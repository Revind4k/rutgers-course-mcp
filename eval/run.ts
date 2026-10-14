// Runs every task in eval/tasks.json through the agent against the frozen snapshot and grades it.
// Run: npm run eval            (all tasks)
//      npm run eval -- lookup  (one category)
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { connectMcp, runAgent, MODEL, type AgentRun } from "../src/agent.js";
import type { Task } from "./build-tasks.js";
import { grade } from "./grade.js";

// Claude Opus 5.5 list price, $ per million tokens.
const PRICE = { input: 4, output: 20 };
const CONCURRENCY = 4;

const tasks: Task[] = JSON.parse(await readFile(path.resolve("eval/tasks.json"), "utf8"));
const only = process.argv[2];
const selected = only ? tasks.filter((t) => t.category === only || t.id === only) : tasks;
const anthropic = new Anthropic();

type Result = { task: Task; run?: AgentRun; error?: string; pass: boolean; why: string[]; ms: number };
const results: Result[] = [];

async function one(t: Task): Promise<Result> {
  const started = Date.now();
  const mcp = await connectMcp({ SOC_FIXTURE_DIR: path.resolve("fixtures"), ...(t.fault ? { SOC_FAULT: t.fault } : {}) });
  try {
    const run = await runAgent(mcp, t.question, anthropic);
    const g = grade(t, run.answer);
    return { task: t, run, ...g, ms: Date.now() - started };
  } catch (err) {
    return { task: t, error: String(err), pass: false, why: ["agent error"], ms: Date.now() - started };
  } finally {
    await mcp.close();
  }
}

const queue = [...selected];
await Promise.all(
  Array.from({ length: CONCURRENCY }, async () => {
    for (let t = queue.shift(); t; t = queue.shift()) {
      const r = await one(t);
      results.push(r);
      console.log(`${r.pass ? "PASS" : "FAIL"} ${t.id}${r.pass ? "" : "  <- " + r.why.join("; ")}`);
    }
  }),
);

const by = (k: (r: Result) => string) =>
  Object.entries(results.reduce((m: Record<string, Result[]>, r) => ((m[k(r)] ??= []).push(r), m), {}));
const pct = (rs: Result[]) => `${rs.filter((r) => r.pass).length}/${rs.length}`;
const tokens = results.reduce((s, r) => ({ input: s.input + (r.run?.usage.input ?? 0), output: s.output + (r.run?.usage.output ?? 0) }), { input: 0, output: 0 });
const cost = (tokens.input * PRICE.input + tokens.output * PRICE.output) / 1e6;
const calls = results.map((r) => r.run?.toolCalls.length ?? 0);

console.log(`\nmodel ${MODEL}`);
console.log(`overall ${pct(results)} (${Math.round((100 * results.filter((r) => r.pass).length) / results.length)}%)`);
for (const [cat, rs] of by((r) => r.task.category)) console.log(`  ${cat.padEnd(9)} ${pct(rs)}`);
console.log(`tool calls/task: mean ${(calls.reduce((a, b) => a + b, 0) / calls.length).toFixed(1)}, max ${Math.max(...calls)}`);
console.log(`tokens: ${tokens.input} in / ${tokens.output} out, about $${cost.toFixed(2)}`);

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
await writeFile(path.resolve(`eval/results/${stamp}.json`), JSON.stringify({ model: MODEL, tokens, cost, results }, null, 2));
