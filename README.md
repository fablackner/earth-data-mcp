# earth-data-mcp

An [MCP](https://modelcontextprotocol.io) server that makes live Earth data
usable by AI agents. Its initial data sources cover natural hazards: earthquakes
from the USGS FDSN event catalog and volcanic activity from the Smithsonian
Global Volcanism Program.

It is deliberately multi-consumer. The same server backs an unattended Discord
bot and an interactive Claude Code session — one tool definition, two callers,
one place to fix a bug. That is the argument for MCP here; wrapping an API in a
protocol for a single client would just be a network hop with extra steps.

## Tools

Parameterised queries the model composes per question.

| Tool | Purpose |
| --- | --- |
| `search_earthquakes` | Query the USGS catalog by magnitude, time window, and location radius. |
| `get_earthquake` | Full detail for one event, by USGS event id. |
| `search_volcanic_activity` | Current Weekly Volcanic Activity Report, optionally filtered by volcano or country. |

Every `search_earthquakes` call maps onto documented FDSN parameters and is
echoed back in the response under `query`, so any result can be replayed as a
plain URL and checked against the raw feed. That property is what makes the
eval (below) possible.

## Resources

Whole documents, no arguments — the model doesn't decide anything to fetch them,
so they don't belong in the tool surface.

| URI | Contents |
| --- | --- |
| `hazard://earthquakes/significant-week` | USGS curated significant-events feed, past 7 days. |
| `hazard://volcanoes/weekly-report` | The full current GVP weekly report, unfiltered. |

## Usage

Two transports, one server definition (`src/server.js`).

```sh
bun install
bun run start      # stdio — local clients spawn the process
bun run start:http # HTTP  — remote and serverless clients connect to it
```

Register it with Claude Code (stdio):

```sh
claude mcp add earth-data -- bun /absolute/path/to/earth-data-mcp/src/index.js
```

The HTTP mode listens on `PORT` (default 3000) at `/mcp`, plus `/health` for
liveness probes. It runs **stateless** — a fresh server and transport per
request — so concurrent clients cannot observe each other and a dropped
connection leaves nothing to clean up. That also makes it deployable to any
serverless platform without sticky sessions.

The transport choice is a deployment concern, not a design one: stdio requires
the client to spawn the process, which a serverless function cannot reasonably
do per invocation.

## Hosting it

**GitHub Pages cannot host this.** Pages serves static files with no server-side
execution; MCP over Streamable HTTP needs a live process to answer POSTs. The
same rules out any purely static host.

What works, all with usable free tiers:

| Host | Notes |
| --- | --- |
| **Vercel** | `api/mcp.js` + `vercel.json` are already in this repo — `vercel deploy` works as-is |
| Cloudflare Workers | Needs a Workers-flavoured entry point instead of `api/mcp.js` |
| Deno Deploy | Needs a Deno-flavoured entry point |
| Render / Fly.io | Run `bun run start:http` as a long-lived process |

Deploying to Vercel:

```sh
bunx vercel deploy --prod    # → https://<project>.vercel.app/mcp
```

`vercel.json` selects Vercel's Bun runtime, and `bun.lock` makes Vercel use Bun
to install dependencies.

There is nothing to configure: the server holds no secrets and needs no
environment variables, because every upstream it talks to is a public,
unauthenticated feed. `/api/mcp?health` returns a liveness probe.

The serverless entry (`api/mcp.js`) and the long-running entry (`src/index.js`)
share `src/server.js`, so the tool surface cannot drift between them.

> **This endpoint is public and unauthenticated once deployed.** That is
> acceptable here — it is a thin, read-only, cached proxy in front of two public
> feeds, so it exposes nothing that isn't already public and cannot be used to
> mutate anything. It is *not* a template for a server that touches private data:
> that one needs auth on the transport before it goes anywhere near the internet.

## Eval

`eval/` measures whether an agent given only these tools and a question (1) picks
the right tool, (2) parameterises it correctly, and (3) reports an answer
consistent with the raw upstream data.

```sh
ANTHROPIC_API_KEY=... bun run eval
MODEL=claude-opus-4-8 EFFORT=high RUNS=3 bun run eval    # sweep settings
MOCK=1 bun run eval                                      # exercise the harness, no tokens
```

Design decisions worth stating:

- **Deterministic scoring, no LLM judge.** Every check is a predicate over
  recorded tool calls or a comparison against ground truth. Where an objective
  check is available it beats a graded opinion: reproducible, free, and it
  cannot itself hallucinate.
- **Ground truth is fetched at run time, never hardcoded.** Seismic data changes
  hourly; a fixed expected answer would rot within a day and the eval would
  start reporting failures that aren't real.
- **Argument checks are predicates, not exact matches.** There is no single
  correct radius for "near Tokyo". A grader demanding one measures obedience to
  an arbitrary convention, not competence — so the assertion is that each
  argument falls in the band that answers the question (centre within 3° of
  Tokyo, radius 50–2000 km, window within 2 days of 7 days back).
- **Negative cases carry equal weight.** A definitional question that triggers a
  live API call is a failure, and so is answering half a two-part question.
  Over-triggering costs latency and tokens on every conversational aside.
- **`RUNS=n` measures consistency, not just correctness.** Non-determinism is
  the central problem with LLM evals; a single green run says little. The report
  shows per-check pass rates across runs.
- **`MOCK=1` runs a deliberately imperfect scripted agent** (`eval/mock-agent.js`)
  that plants a known failure in each dimension. A scorer that has only ever
  seen passing input is not known to discriminate.

The suite exits non-zero on any failure, so it drops into CI unchanged.

## Operational notes

Read-only public data, so there is no auth and no persistence — a deliberate
scope limit, not a gap. What the server does handle:

- **Caching.** 5-minute TTL on earthquake queries, 1 hour on the weekly volcano
  report (which only changes weekly). Agents re-ask the same question often.
- **Upstream failure.** 4xx is a bad query and surfaces immediately; 5xx and
  network errors get one retry, then report. Retrying a real outage twice is
  just hammering the origin.
- **Timeouts.** 10s per request, so a hung feed can't wedge the agent loop.
- **Errors as tool results.** Upstream failures come back as `isError` tool
  results, not transport crashes — an agent that reads "USGS is down" can say
  so; one that sees a dead server cannot.

## Design notes

**Tools vs. resources.** The split is whether the model has a decision to make.
A magnitude threshold and a time window are decisions, so they are tool
arguments. "The current weekly report" is not, so it is a resource.

**Argument validation over silent defaults.** A partial `latitude`/`longitude`/
`radius_km` triple is rejected rather than quietly falling back to a worldwide
search. A tool that silently answers a different question than the one asked is
worse than one that fails.

**Response shaping.** A raw USGS feature carries ~30 fields, most of them
internal bookkeeping. Each event is flattened to the dozen that matter. Context
spent on `properties.detail` URLs is context not spent on the answer.

## Data sources

- [USGS Earthquake Hazards Program](https://earthquake.usgs.gov/fdsnws/event/1/) (public domain)
- [Smithsonian Global Volcanism Program](https://volcano.si.edu/) Weekly Volcanic Activity Report

## License

MIT
