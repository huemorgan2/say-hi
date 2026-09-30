// LIVE evaluation: holds a scripted English conversation with Jev through the
// real TypeSafe API and scores each reply. This makes PAID calls; it is never
// run by `npm test`. Run with: npm run eval -- <label>
// Cumulative spend across all eval runs is capped (JEV_EVAL_TOTAL_USD, default 3).
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { typeReply, redact } from '../jev-typist.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const app = path.join(here, '..');
if (existsSync(path.join(app, '.env'))) process.loadEnvFile(path.join(app, '.env'));
const key = process.env.TYPESAFE_API_KEY?.trim();
if (!key) { console.error('TYPESAFE_API_KEY is not set.'); process.exit(1); }

const label = process.argv[2] || 'run';
const TOTAL_CAP = Number(process.env.JEV_EVAL_TOTAL_USD || 3);
const outDir = path.join(app, 'logs/eval');
mkdirSync(outDir, { recursive: true });
const spendFile = path.join(outDir, 'spend.json');
const spend = existsSync(spendFile) ? JSON.parse(readFileSync(spendFile, 'utf8')) : { totalUSD: 0, runs: [] };
if (spend.totalUSD >= TOTAL_CAP) { console.error(`Eval spend cap reached: $${spend.totalUSD.toFixed(4)} of $${TOTAL_CAP}.`); process.exit(1); }

// Strict expectations: the reply must say the thing, in order, as a sentence would.
export const TURNS = [
  { user: 'hi', expect: /^(hi|hello|hey)\b/i },
  { user: 'who are you?', expect: /^(i am|i'm|im) (jev|an? \w+)/i },
  { user: 'say boom', expect: /^boom\W*$/i },
  { user: 'what is 2 plus 2?', expect: /^(4|four)\b/i },
  { user: 'what color is the sky?', expect: /^((the )?sky is )?blue\b/i },
  { user: 'how are you?', expect: /^(i am|i'm|im) (good|fine|ok|okay|well|great)|^(good|fine|great)\b/i },
  { user: 'what is your name?', expect: /^((my name is|i am|i'm|im) )?jev\W*$/i },
  { user: 'i feel lonely, any suggestion?', expect: /\b(talk to|call|visit|meet|chat with) (a |your )?(friend|friends|someone|family)|\bgo for a walk\b/i },
  { user: 'count to three', expect: /^(1|one)\W+(2|two)\W+(3|three)\W*$/i },
  { user: 'what does a cat say?', expect: /\bmeow\b/i },
  { user: 'repeat after me: I am Jev', expect: /^i am jev\W*$/i },
  { user: 'what is 12 plus 7?', expect: /^(19|nineteen)\b/i },
  { user: 'what year comes after 1999?', expect: /\b2000\b/ },
  { user: 'what is half of 3?', expect: /\b1\.5\b/ },
  { user: 'what is 3x4', expect: /^(12|twelve)\b/i },
  { user: 'who invented the theory of relativity?', expect: /\beinstein\b/i },
  { user: 'that is wrong, it is 7', expect: /\b(sorry|you'?re right|you are right|my mistake|oops|ok)\b/i },
  { user: 'bye', expect: /^(bye|goodbye|see you)\b/i },
];

const frequencyWords = readFileSync(path.join(app, 'node_modules/predictionary/demo/words_en.txt'), 'utf8').split('\n').map(l => l.trim().split(' ')[2] || '');
const vocab = new Set([readFileSync(path.join(app, 'words.txt'), 'utf8'), ...frequencyWords].join(' ').toLowerCase().replace(/'/g, '').split(/\s+/).filter(Boolean));
const wordsOf = t => t.toLowerCase().replace(/[’']/g, '').match(/[a-z0-9]+/g) || [];
function spelling(text, history) {
  const known = new Set([...vocab, ...history.filter(m => m.role === 'user').flatMap(m => wordsOf(m.text))]);
  const w = wordsOf(text);
  return w.length ? w.filter(x => known.has(x) || /^\d+$/.test(x)).length / w.length : 0;
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const logFile = path.join(outDir, `${stamp}-${label}.jsonl`);
const history = [], rows = [];
let runCost = 0;
for (const turn of TURNS) {
  history.push({ role: 'user', text: turn.user });
  const remaining = TOTAL_CAP - spend.totalUSD - runCost;
  if (remaining <= 0) { console.error('Stopping: eval spend cap reached.'); break; }
  let result;
  try {
    result = await typeReply({
      history: [...history], key, maxKeystrokes: 120, predictWords: process.env.JEV_EVAL_NO_WORDS !== '1', pickAnswer: process.env.JEV_EVAL_NO_ANSWER !== '1', budgetMicroT: Math.min(0.05, remaining) * 1e9,
      log: e => appendFileSync(logFile, JSON.stringify({ ts: new Date().toISOString(), turn: turn.user, ...e }).replace(/apikey_[A-Za-z0-9_]+/g, '[redacted]') + '\n'),
    });
  } catch (error) {
    result = { reason: 'error', error: redact(error.message), ...(error.partial || {}) };
  }
  runCost += result.costUSD || 0;
  const text = (result.text || '').trim();
  if (text) history.push({ role: 'jev', text });
  const row = { user: turn.user, jev: text, goal: result.goal, answer: result.answer, reason: result.reason, keys: result.keystrokes || 0, costUSD: result.costUSD || 0,
    sent: result.reason === 'send', spelling: spelling(text, history.slice(0, -1)), relevant: turn.expect.test(text) };
  rows.push(row);
  console.log(`${row.sent ? 'SEND' : row.reason.toUpperCase().padEnd(4)} ${row.relevant ? '✓' : '✗'} spell ${(row.spelling * 100).toFixed(0).padStart(3)}% ${String(row.keys).padStart(3)} keys ${(row.goal || "").padEnd(9)} ${(row.answer ? '[' + row.answer + ']' : '').padEnd(12)} ${JSON.stringify(turn.user)} → ${JSON.stringify(text)}${result.error ? '  ' + result.error : ''}`);
}

const mean = f => rows.reduce((a, r) => a + f(r), 0) / rows.length;
const summary = { label, at: new Date().toISOString(), turns: rows.length, sent: mean(r => r.sent), spelling: mean(r => r.spelling), relevant: mean(r => r.relevant), keysPerReply: mean(r => r.keys), costUSD: runCost };
summary.score = summary.sent + summary.spelling + summary.relevant;
writeFileSync(path.join(outDir, `${stamp}-${label}.json`), JSON.stringify({ summary, rows }, null, 2));
spend.totalUSD += runCost; spend.runs.push({ label, at: summary.at, costUSD: runCost, score: summary.score });
writeFileSync(spendFile, JSON.stringify(spend, null, 2));
console.log(`\n${label}: score ${summary.score.toFixed(2)}/3 (strict set v4, 18 turns)  sent ${(summary.sent * 100).toFixed(0)}%  spelling ${(summary.spelling * 100).toFixed(0)}%  relevant ${(summary.relevant * 100).toFixed(0)}%  ${summary.keysPerReply.toFixed(1)} keys/reply  $${runCost.toFixed(4)} (eval total $${spend.totalUSD.toFixed(4)} of $${TOTAL_CAP})`);
