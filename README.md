# rutgers-course-mcp

An [MCP](https://modelcontextprotocol.io) server that exposes the public Rutgers Schedule of Classes as tools, plus a Claude agent that answers course-planning questions with them, and an eval that measures how often it gets the answer right.

```
$ npm run ask -- "Can I take Computer Architecture and Data Structures together? Which sections are open?"
```

## Tools

| Tool | What it does |
|---|---|
| `search_courses` | Keyword, subject, core-code, level and open-seat filters over ~4,400 courses |
| `get_course` | Credits, prerequisites (HTML stripped), core codes, open-section count |
| `get_sections` | Every section with index, open status, instructors, meeting times |
| `check_open` | Live open/closed status for specific index numbers |
| `find_conflicts` | Pairwise meeting-time overlaps for a set of sections |
| `list_subjects` | Subject codes and names |

Course numbers are accepted as `01:198:211`, `198:211` or `198211`.

## Design

```
agent.ts ──stdio──> server.ts (MCP) ──> tools.ts (pure functions) ──> soc.ts ──> classes.rutgers.edu/soc/api
   │                                                                    │
   └── Claude (tool-use loop)                                           └── timeout, retry with backoff,
                                                                            1h course cache, live open seats
```

- **Failure handling.** `soc.ts` times out each request, retries transient failures with exponential backoff, and raises a typed `SocError`. The server turns that into an MCP tool error with a plain-language message, so the agent can retry or tell the user the data is unavailable instead of guessing.
- **Testable core.** All tool logic lives in `tools.ts` as pure functions over SOC data, unit-tested against a frozen Fall 2026 snapshot in `fixtures/`.
- **Fault injection.** `SOC_FAULT=timeout:N` makes the first N upstream calls fail, which is how the failure-handling evals and tests run.

## Eval

`eval/build-tasks.ts` generates 20 tasks from the frozen snapshot, so every expected answer is computed from the data rather than written by hand. Grading is programmatic (required substrings, forbidden substrings, YES/NO prefixes), with no LLM judge, so scores are deterministic and free to recompute.

| Category | Tasks | Checks |
|---|---|---|
| lookup | 5 | credits, prerequisites, titles |
| sections | 5 | open sections, instructors, counts |
| search | 4 | finding a course by title, subject codes, core-code counts |
| schedule | 3 | real conflicting and non-conflicting section pairs |
| failure | 3 | recovers from a transient timeout; refuses to guess during an outage; handles a course that isn't offered |

Results (Claude Opus 5.5, effort `medium`, frozen Fall 2026 snapshot, 2026-10-14):

| | |
|---|---|
| Accuracy | **20/20** (lookup 5/5, sections 5/5, search 4/4, schedule 3/3, failure 3/3) |
| Tool calls per task | mean 1.1, max 2 |
| Cost for the full run | about $0.59 (130K input / 3.4K output tokens) |

The first run scored 19/20. The one failure was the grader, not the agent: during the simulated outage it retried once, said the data source had timed out, and refused to guess. The grader only accepted words like "unavailable", so I widened it to accept "can't", "timed out" and "won't guess", then re-ran the whole eval from scratch. Twenty tasks is a small set; the next step is harder multi-step planning tasks (building a full conflict-free schedule from a list of required courses).

## Run it

```bash
npm install
npm test                      # unit tests, no network
npm run server                # MCP server on stdio (add it to any MCP client)
echo 'ANTHROPIC_API_KEY=...' > .env   # gitignored; read by ask/eval
npm run ask -- "Who teaches section 11548?"
npm run eval                  # full eval against the snapshot; prints accuracy, tool calls, cost
```

Data comes from the public Rutgers SOC API (`classes.rutgers.edu/soc/api`). This project is not affiliated with Rutgers.
