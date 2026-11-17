/**
 * Runs every case in cases.json against the real model and reports a pass rate.
 *
 *   OPENAI_API_KEY=... npm run eval                 # default model, fail under 90%
 *   OPENAI_API_KEY=... npm run eval -- --model gpt-4.1-mini --min 0.95
 *
 * Results are written to evals/results/<timestamp>.json so runs can be compared
 * when the prompt or the model changes.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import OpenAI from 'openai';
import { openAICompleter, parseSpend } from '../src/parse.js';
import { PROMPT_VERSION } from '../src/prompt.js';
import { loadCases } from './cases.js';
import { byTag, scoreCase, type CaseScore } from './score.js';

const { values } = parseArgs({
  options: {
    model: { type: 'string', default: 'gpt-4o-mini' },
    min: { type: 'string', default: '0.9' },
  },
});

if (!process.env.OPENAI_API_KEY) {
  console.error('OPENAI_API_KEY is not set. Copy .env.example to .env or export it.');
  process.exit(1);
}

const model = values.model!;
const complete = openAICompleter(new OpenAI(), model);
const cases = loadCases();
const scores: CaseScore[] = [];

for (const c of cases) {
  const result = await parseSpend(c.input, complete);
  const score = scoreCase(c, result);
  scores.push(score);
  const mark = score.pass ? 'PASS' : 'FAIL';
  console.log(`${mark}  ${c.id.padEnd(26)} ${score.failures.join('; ')}`);
}

const passed = scores.filter((s) => s.pass).length;
const rate = passed / scores.length;

console.log(`\n${passed}/${scores.length} passed (${(rate * 100).toFixed(1)}%)  model=${model}  prompt=${PROMPT_VERSION}\n`);
for (const [tag, { pass, total }] of Object.entries(byTag(scores)).sort()) {
  console.log(`  ${tag.padEnd(16)} ${pass}/${total}`);
}

mkdirSync(new URL('./results/', import.meta.url), { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
writeFileSync(
  new URL(`./results/${stamp}.json`, import.meta.url),
  JSON.stringify({ model, prompt: PROMPT_VERSION, passed, total: scores.length, scores }, null, 2),
);

if (rate < Number(values.min)) {
  console.error(`\nPass rate ${(rate * 100).toFixed(1)}% is below the ${Number(values.min) * 100}% threshold.`);
  process.exit(1);
}
