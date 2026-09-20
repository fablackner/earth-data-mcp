#!/usr/bin/env bun
/**
 * Eval harness for the earth-data MCP server.
 *
 * What it measures: whether an agent, given only these tools and a question,
 * (1) selects the right tool, (2) parameterises it correctly, and (3) reports an
 * answer consistent with the raw upstream data.
 *
 * Scoring is deterministic — predicates over recorded tool calls and ground
 * truth fetched from the source API at run time. No LLM judge. Where a check
 * can be made objectively, an objective check is worth more than a graded
 * opinion: it is reproducible, free, and it cannot itself hallucinate.
 *
 * Usage:
 *   ANTHROPIC_API_KEY=... bun eval/run.js
 *   MODEL=claude-opus-4-8 EFFORT=high RUNS=3 bun eval/run.js
 */
import Anthropic from '@anthropic-ai/sdk';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { cases } from './cases.js';

const here = dirname(fileURLToPath(import.meta.url));
const MODEL = process.env.MODEL ?? 'claude-opus-4-8';
const EFFORT = process.env.EFFORT ?? null; // low | medium | high | xhigh | max
const RUNS = Number(process.env.RUNS ?? 1);
const MAX_STEPS = 6;

const SYSTEM = `You answer questions about natural hazards using the supplied tools.

Call a tool whenever the answer depends on current data — recent earthquakes, current volcanic activity, or details of a specific event. Answer directly from your own knowledge for definitional or historical questions the tools cannot reach.

Be precise about magnitudes, place names and times. Never state a figure the tool output does not support.`;

//----------------------------------------------------------------------------
// Agent loop
//----------------------------------------------------------------------------

/**
 * Call a tool, turning a protocol-level rejection back into a tool error.
 *
 * An unknown or disabled tool rejects rather than resolving with `isError`, so
 * a hallucinated tool name would otherwise abort the run instead of being
 * scored. The model should see its mistake and get another step, exactly as it
 * would for an upstream failure.
 */
async function callTool(mcp, name, input) {
  try {
    return await mcp.callTool({ name, arguments: input });
  } catch (error) {
    return { content: [{ type: 'text', text: `tool call failed: ${error.message}` }], isError: true };
  }
}

/**
 * Run one question to completion, recording every tool call.
 *
 * A manual loop rather than the SDK tool runner: recording each call with its
 * arguments *is* the measurement here, and an explicit loop makes exactly what
 * was scored auditable from the source.
 */
async function runCase(anthropic, mcp, tools, question) {
  const messages = [{ role: 'user', content: question }];
  const calls = [];
  let finalText = '';

  for (let step = 0; step < MAX_STEPS; step++) {
    const request = {
      model: MODEL,
      max_tokens: 4096,
      system: SYSTEM,
      tools,
      messages,
    };
    if (EFFORT) {
      request.thinking = { type: 'adaptive' };
      request.output_config = { effort: EFFORT };
    }

    const response = await anthropic.messages.create(request);
    messages.push({ role: 'assistant', content: response.content });

    finalText = response.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('\n');

    if (response.stop_reason !== 'tool_use') break;

    const results = [];
    for (const block of response.content) {
      if (block.type !== 'tool_use') continue;
      calls.push({ name: block.name, input: block.input });
      const output = await callTool(mcp, block.name, block.input);
      results.push({
        type: 'tool_result',
        tool_use_id: block.id,
        content: output.content.map((c) => c.text).join('\n'),
        is_error: output.isError === true,
      });
    }
    messages.push({ role: 'user', content: results });
  }

  return { calls, finalText };
}

//----------------------------------------------------------------------------
// Scoring
//----------------------------------------------------------------------------

function scoreCase(testCase, { calls, finalText }, truth) {
  const called = calls.map((c) => c.name);
  const checks = [];

  for (const name of testCase.expect.required) {
    checks.push({
      dimension: 'selection',
      label: `calls ${name}`,
      pass: called.includes(name),
      detail: called.length ? `called: ${called.join(', ')}` : 'called no tools',
    });
  }
  for (const name of testCase.expect.forbidden ?? []) {
    checks.push({
      dimension: 'selection',
      label: `does not call ${name}`,
      pass: !called.includes(name),
      detail: `called: ${called.join(', ') || 'none'}`,
    });
  }

  // Argument predicates run against the first call of the primary tool.
  const primary = testCase.expect.required[0];
  if (primary) {
    const call = calls.find((c) => c.name === primary);
    if (call) {
      for (const result of testCase.expect.args(call.input)) {
        checks.push({ dimension: 'arguments', ...result });
      }
    }
  }

  if (testCase.answerCheck) {
    const result = testCase.answerCheck(finalText, truth);
    if (result) checks.push({ dimension: 'answer', ...result });
  }

  return checks;
}

//----------------------------------------------------------------------------
// Reporting
//----------------------------------------------------------------------------

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

function report(results) {
  const dimensions = { selection: [0, 0], arguments: [0, 0], answer: [0, 0] };
  let casesPassed = 0;

  for (const { testCase, runs } of results) {
    const allPassed = runs.every((r) => r.checks.every((c) => c.pass));
    if (allPassed) casesPassed++;

    const rate = runs.filter((r) => r.checks.every((c) => c.pass)).length;
    const marker = allPassed ? `${GREEN}PASS${RESET}` : `${RED}FAIL${RESET}`;
    const consistency = RUNS > 1 ? ` ${DIM}[${rate}/${RUNS} runs]${RESET}` : '';
    console.log(`\n${marker} ${testCase.id}${consistency}`);
    console.log(`${DIM}  ${testCase.question}${RESET}`);

    // Report each distinct check once, noting how often it held across runs.
    const byLabel = new Map();
    for (const run of runs) {
      for (const check of run.checks) {
        const entry = byLabel.get(check.label) ?? { ...check, passes: 0 };
        entry.passes += check.pass ? 1 : 0;
        if (!check.pass) entry.detail = check.detail;
        byLabel.set(check.label, entry);
      }
    }
    for (const check of byLabel.values()) {
      const total = dimensions[check.dimension];
      total[0] += check.passes;
      total[1] += runs.length;
      const passedAll = check.passes === runs.length;
      const icon = passedAll ? `${GREEN}✓${RESET}` : `${RED}✗${RESET}`;
      const count = RUNS > 1 ? ` ${DIM}(${check.passes}/${RUNS})${RESET}` : '';
      console.log(`  ${icon} ${check.label}${count}`);
      if (!passedAll && check.detail) console.log(`${DIM}      ${check.detail}${RESET}`);
    }

    const toolTrace = runs[0].calls.map((c) => c.name).join(' → ') || 'no tools';
    console.log(`${DIM}  tools: ${toolTrace}${RESET}`);
  }

  console.log(`\n${'─'.repeat(60)}`);
  console.log(`model: ${MODEL}${EFFORT ? `  effort: ${EFFORT}` : '  thinking: off'}  runs: ${RUNS}`);
  for (const [name, [passed, total]] of Object.entries(dimensions)) {
    if (total === 0) continue;
    const pct = ((passed / total) * 100).toFixed(0);
    console.log(`${name.padEnd(11)} ${String(passed).padStart(3)}/${String(total).padEnd(3)} ${pct}%`);
  }
  console.log(`${'─'.repeat(60)}`);
  console.log(`cases fully passed: ${casesPassed}/${results.length}`);

  return casesPassed === results.length;
}

//----------------------------------------------------------------------------

/**
 * MOCK=1 replays a scripted agent instead of calling the API — it exercises the
 * MCP round trip, the ground-truth fetch, the scorer and the report without
 * spending tokens. The script is deliberately imperfect (see mock-agent.js): a
 * scorer that has only ever seen passing input is not known to discriminate.
 */
async function runMockCase(mcp, testCase) {
  const { script } = await import('./mock-agent.js');
  const plan = script[testCase.id] ?? { calls: [], text: '' };
  const calls = [];
  for (const call of plan.calls) {
    calls.push(call);
    await callTool(mcp, call.name, call.input);
  }
  return { calls, finalText: plan.text };
}

async function main() {
  const mock = process.env.MOCK === '1';
  if (!mock && !process.env.ANTHROPIC_API_KEY) {
    console.error(
      'ANTHROPIC_API_KEY is not set — the eval needs it to run the agent.\n' +
        'Run MOCK=1 bun eval/run.js to exercise the harness without it.',
    );
    process.exit(2);
  }

  const anthropic = mock ? null : new Anthropic();
  const mcp = new Client({ name: 'hazards-eval', version: '1.0.0' });
  await mcp.connect(
    new StdioClientTransport({ command: 'bun', args: [join(here, '..', 'src', 'index.js')] }),
  );

  // The agent sees exactly what any MCP client sees — no hand-written tool
  // definitions, so the eval measures the real server surface.
  const { tools: mcpTools } = await mcp.listTools();
  const tools = mcpTools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema,
  }));
  console.log(`${DIM}loaded ${tools.length} tools from the MCP server${RESET}`);

  const results = [];
  for (const testCase of cases) {
    const truth = testCase.groundTruth ? await testCase.groundTruth() : null;
    const runs = [];
    for (let i = 0; i < RUNS; i++) {
      const outcome = mock
        ? await runMockCase(mcp, testCase)
        : await runCase(anthropic, mcp, tools, testCase.question);
      runs.push({ ...outcome, checks: scoreCase(testCase, outcome, truth) });
    }
    results.push({ testCase, runs });
  }

  await mcp.close();
  process.exit(report(results) ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(2);
});
