/**
 * Runs every case in cases.json against the real model and reports a pass rate.
 *
 *   OPENAI_API_KEY=... npm run eval                 # default model, fail under 90%
 *   OPENAI_API_KEY=... npm run eval -- --model gpt-4.1-mini --min 0.95
 *
 * Results are written to evals/results/<timestamp>.json so runs can be compared
 * when the prompt or the model changes.
 *
 * Cases tagged `hard` (genuinely ambiguous or misheard input) are reported separately and don't count toward the
 * pass-rate gate. They're there to check that confidence drops where the model is likely to be wrong.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import OpenAI from 'openai';
import { openAICompleter, parseSpend } from '../src/parse.js';
import { PROMPT_VERSION } from '../src/prompt.js';
import type { ParseResult } from '../src/parse.js';
import { loadCases } from './cases.js';
import {
  byTag,
  CHECKED_FIELDS,
  fieldInstances,
  scoreCase,
  suggestThreshold,
  thresholdTable,
  type CaseScore,
  type FieldInstance,
} from './score.js';

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
const scores: (CaseScore & { result: ParseResult })[] = [];
const instances: FieldInstance[] = [];
const pct = (p: number) => `${Math.round(p * 100)}%`.padStart(4);

for (const c of cases) {
  const result = await parseSpend(c.input, complete);
  const score = scoreCase(c, result);
  scores.push({ ...score, result });
  instances.push(...fieldInstances(c, result));
  const mark = score.pass ? 'PASS' : 'FAIL';
  const review = result.ok && result.needs_review ? `  [review: ${result.needs_review.join(', ')}]` : '';
  console.log(`${mark}  ${c.id.padEnd(26)} ${score.failures.join('; ')}${review}`);
}

const main = scores.filter((s) => !s.tags.includes('hard'));
const hard = scores.filter((s) => s.tags.includes('hard'));
const passed = main.filter((s) => s.pass).length;
const rate = passed / main.length;

console.log(`\n${passed}/${main.length} passed (${(rate * 100).toFixed(1)}%)  model=${model}  prompt=${PROMPT_VERSION}`);
if (hard.length) console.log(`hard: ${hard.filter((s) => s.pass).length}/${hard.length} (not gated)`);
console.log();
for (const [tag, { pass, total }] of Object.entries(byTag(scores)).sort()) {
  console.log(`  ${tag.padEnd(16)} ${pass}/${total}`);
}

// Confidence: does a low probability land on the wrong values? Wrong fields are few, so thresholds are chosen
// from the false-alarm side (how many correct fields get flagged), and the wrong ones are shown as examples.
console.log('\nConfidence (✓ correct, ✗ wrong), lowest first');
for (const field of CHECKED_FIELDS) {
  const list = instances.filter((i) => i.field === field).sort((a, b) => a.p - b.p);
  if (!list.length) continue;
  console.log(`\n  ${field}  (suggested threshold: ${suggestThreshold(list) ?? 'none'}, at most 5% of correct fields flagged)`);
  for (const i of list.slice(0, 8)) console.log(`    ${pct(i.p)} ${i.correct ? '✓' : '✗'} ${i.id.padEnd(26)} ${i.value}`);
  if (list.length > 8) console.log(`    … ${list.length - 8} more, all ≥ ${pct(list[8]!.p).trim()}`);
  console.log('    threshold  false alarms  caught');
  for (const r of thresholdTable(list)) {
    console.log(`    < ${r.threshold.toFixed(2)}     ${`${r.falseAlarms}/${r.correct}`.padEnd(12)}  ${r.caught}/${r.wrong}`);
  }
}

console.log('\nAmbiguous cases (the "right" answer is itself debatable)');
for (const s of scores.filter((s) => ['ambiguous', 'inference', 'hard'].some((t) => s.tags.includes(t)))) {
  if (!s.result.ok) continue;
  const cat = s.result.confidence?.fields.category;
  const alts = cat?.alternatives?.map((a) => `${a.value} ${pct(a.p).trim()}`).join(', ');
  console.log(`  ${s.id.padEnd(26)} ${s.result.movement.category} ${cat ? pct(cat.p).trim() : '?'}${alts ? `  (${alts})` : ''}`);
}

mkdirSync(new URL('./results/', import.meta.url), { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
writeFileSync(
  new URL(`./results/${stamp}.json`, import.meta.url),
  JSON.stringify({ model, prompt: PROMPT_VERSION, passed, total: main.length, hard: { passed: hard.filter((s) => s.pass).length, total: hard.length }, scores }, null, 2),
);

if (rate < Number(values.min)) {
  console.error(`\nPass rate ${(rate * 100).toFixed(1)}% is below the ${Number(values.min) * 100}% threshold.`);
  process.exit(1);
}
