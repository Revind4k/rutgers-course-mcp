// Agent: connects to the MCP server over stdio and lets Claude answer questions with its tools.
import Anthropic from "@anthropic-ai/sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const MODEL = process.env.AGENT_MODEL ?? "claude-opus-5-5";
const MAX_TURNS = 12;

const SYSTEM = `You help Rutgers students with course planning using the Schedule of Classes tools.
The default term is Fall 2026, New Brunswick. Always look data up with the tools rather than answering from memory, and quote course strings (e.g. 01:198:211) and section index numbers exactly as the tools return them.
If a tool returns an error, you may retry it once. If it still fails, say plainly that the data source is unavailable instead of guessing.
Keep the final answer short and specific.`;

export interface AgentRun {
  answer: string;
  toolCalls: { name: string; input: unknown; isError: boolean }[];
  turns: number;
  stopReason: string | null;
  usage: { input: number; output: number };
}

export async function connectMcp(env: Record<string, string> = {}) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", path.join(here, "server.ts")],
    env: { ...(process.env as Record<string, string>), ...env },
    stderr: "inherit",
  });
  const mcp = new Client({ name: "rutgers-course-agent", version: "0.1.0" });
  await mcp.connect(transport);
  return mcp;
}

export async function runAgent(mcp: Client, question: string, anthropic = new Anthropic()): Promise<AgentRun> {
  const { tools: mcpTools } = await mcp.listTools();
  // MCP tool definitions map directly onto Claude tool definitions.
  const tools: Anthropic.Beta.BetaTool[] = mcpTools.map((t) => ({
    name: t.name,
    description: t.description ?? "",
    input_schema: t.inputSchema as Anthropic.Beta.BetaTool.InputSchema,
  }));

  const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: "user", content: question }];
  const run: AgentRun = { answer: "", toolCalls: [], turns: 0, stopReason: null, usage: { input: 0, output: 0 } };

  while (run.turns < MAX_TURNS) {
    run.turns++;
    const response = await anthropic.beta.messages.create({
      model: MODEL,
      max_tokens: 16000,
      system: SYSTEM,
      tools,
      messages,
      output_config: { effort: "medium" },
      // On a safety-classifier refusal, let the API re-run the turn on a fallback model.
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
    } as Anthropic.Beta.MessageCreateParamsNonStreaming);

    run.usage.input += response.usage.input_tokens;
    run.usage.output += response.usage.output_tokens;
    run.stopReason = response.stop_reason;
    messages.push({ role: "assistant", content: response.content });

    if (response.stop_reason === "pause_turn") continue;
    const toolUses = response.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
    if (response.stop_reason !== "tool_use" || toolUses.length === 0) {
      run.answer = response.content
        .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
        .map((b) => b.text)
        .join("\n")
        .trim();
      return run;
    }

    // Run parallel tool calls concurrently and return every result in one user message.
    const results = await Promise.all(
      toolUses.map(async (tu): Promise<Anthropic.Beta.BetaToolResultBlockParam> => {
        let text: string;
        let isError = false;
        try {
          const r = await mcp.callTool({ name: tu.name, arguments: tu.input as Record<string, unknown> });
          const parts = (r.content as { type: string; text?: string }[]) ?? [];
          text = parts.map((p) => p.text ?? "").join("\n");
          isError = Boolean(r.isError);
        } catch (err) {
          text = `tool transport error: ${String(err)}`;
          isError = true;
        }
        run.toolCalls.push({ name: tu.name, input: tu.input, isError });
        return { type: "tool_result", tool_use_id: tu.id, content: text, is_error: isError };
      }),
    );
    messages.push({ role: "user", content: results });
  }
  run.answer = "(stopped: turn limit reached)";
  return run;
}

// CLI: npm run ask -- "Which sections of Data Structures are open?"
if (import.meta.url === `file://${process.argv[1]}`) {
  const question = process.argv.slice(2).join(" ");
  if (!question) {
    console.error('usage: npm run ask -- "your question"');
    process.exit(1);
  }
  const mcp = await connectMcp();
  try {
    const run = await runAgent(mcp, question);
    console.log(run.answer);
    console.error(`\n[${run.turns} turns, ${run.toolCalls.length} tool calls: ${run.toolCalls.map((t) => t.name).join(", ")}]`);
  } finally {
    await mcp.close();
  }
}
