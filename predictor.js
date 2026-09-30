// Word prediction (predictionary, AGPL-3.0) so Jev can pick a whole word
// instead of typing it letter by letter. One fresh predictor per reply:
// ~25k English words ranked by frequency, the app's word list, and what the
// user wrote in this conversation (which also teaches next-word pairs).
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import Predictionary from 'predictionary/src/index.mjs'; // package "main" lacks an extension

const require = createRequire(import.meta.url);
const FREQUENCY_LINES = readFileSync(require.resolve('predictionary/demo/words_en.txt'), 'utf8')
  .split('\n').filter(line => /^\d+ [\d.]+ [A-Za-z']+$/.test(line.trim()));
const FREQUENCY_LIST = FREQUENCY_LINES.join('\n');
const LISTED = new Set(FREQUENCY_LINES.map(line => line.trim().split(' ')[2].toLowerCase()));
const APP_WORDS_ALL = readFileSync(new URL('./words.txt', import.meta.url), 'utf8').split(/\s+/).filter(Boolean);
const APP_WORDS = APP_WORDS_ALL.filter(w => !LISTED.has(w));
const COMMON = FREQUENCY_LINES.slice(0, 200).map(line => line.trim().split(' ')[2]).filter(w => /^[a-z']+$/.test(w));
const WORD = /^[A-Za-z][A-Za-z']*$/;

export function createPredictor(history) {
  const p = Predictionary.instance();
  p.parseWords(FREQUENCY_LIST, { elementSeparator: '\n', rankSeparator: ' ', wordPosition: 2, rankPosition: 0 });
  p.addWords(APP_WORDS);
  const userWords = [];
  for (const m of history) if (m.role === 'user') p.learnFromText(m.text);
  for (const m of [...history].reverse()) if (m.role === 'user') userWords.push(...(m.text.match(/[A-Za-z][A-Za-z']*/g) || []));
  return {
    // Words that complete the current partial word or, after a space, come next.
    // Next-word pairs are only known from this conversation, so after a space
    // the list is topped up with the user's words and then common words.
    suggest(draft, max = 8) {
      const atWordStart = draft === '' || /\s$/.test(draft);
      const found = p.predict(draft, { maxPredictions: max * 3 });
      const pool = atWordStart ? [...found, ...userWords, ...COMMON] : found;
      const seen = new Set(), out = [];
      for (const w of pool) {
        if (!WORD.test(w) || seen.has(w.toLowerCase())) continue;
        seen.add(w.toLowerCase());
        out.push(w);
        if (out.length === max) break;
      }
      return out;
    },
  };
}

// Candidates for the answer tournament: the user's own words, numbers 0-255,
// years 1900-2100, the app's word list and the 10,000 most frequent English words.
export function answerCandidates(history) {
  const userWords = history.filter(m => m.role === 'user').reverse().flatMap(m => m.text.match(/[A-Za-z][A-Za-z']*|\d+/g) || []);
  const numbers = [...Array.from({ length: 256 }, (_, i) => String(i)), ...Array.from({ length: 201 }, (_, i) => String(1900 + i))];
  const frequent = FREQUENCY_LINES.slice(0, 10000).map(line => line.trim().split(' ')[2]);
  const seen = new Set(), out = [];
  for (const w of [...userWords, ...numbers, ...APP_WORDS_ALL, ...frequent]) {
    if (!/^([A-Za-z][A-Za-z']*|\d+)$/.test(w) || seen.has(w.toLowerCase())) continue;
    seen.add(w.toLowerCase());
    out.push(w);
  }
  return out;
}
