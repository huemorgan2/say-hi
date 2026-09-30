// Jev types a chat reply one keystroke at a time. Every keystroke is one
// TypeSafe JEV choice request whose options are the keys of a keyboard.
export const ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
export const MODEL = 'jev-1.13.0';
export const INPUT_MICROT = 42; // provider price per input token, in microT (1e-9 USD)
export const DEFAULT_TIMEOUT_MS = 30000;

import { readFileSync } from 'node:fs';
import { createPredictor, answerCandidates } from './predictor.js';
const COMMON_WORDS = [...new Set(readFileSync(new URL('./words.txt', import.meta.url), 'utf8').toLowerCase().split(/\s+/).filter(Boolean))];
const norm = w => w.toLowerCase().replace(/^'+/, '');
const wordsIn = text => (text.match(/[A-Za-z']+/g) || []).map(norm).filter(Boolean);
// Spelling vocabulary for this reply: the user's own words (latest message
// first), then common English. (Common-first was measured worse: iter9.)
export const vocabulary = history => [...new Set([...history.filter(m => m.role === 'user').reverse().flatMap(m => wordsIn(m.text)), ...COMMON_WORDS])];
const trailingWord = text => norm(text.match(/[A-Za-z']+$/)?.[0] || '');

const PUNCTUATION = {
  period: ['.', 'period'], comma: [',', 'comma'], question: ['?', 'question mark'], exclamation: ['!', 'exclamation mark'],
  apostrophe: ["'", 'apostrophe'], quote: ['"', 'double quote'], hyphen: ['-', 'hyphen / minus'], colon: [':', 'colon'],
  semicolon: [';', 'semicolon'], lparen: ['(', 'opening parenthesis'], rparen: [')', 'closing parenthesis'],
  slash: ['/', 'slash'], at: ['@', 'at sign'], hash: ['#', 'hash'], ampersand: ['&', 'ampersand'], plus: ['+', 'plus'],
  equals: ['=', 'equals'], asterisk: ['*', 'asterisk'], percent: ['%', 'percent'], dollar: ['$', 'dollar'], underscore: ['_', 'underscore'],
};

// id -> { char?, action?, label, description }
export const KEYS = (() => {
  const keys = {};
  for (const c of 'abcdefghijklmnopqrstuvwxyz') {
    keys[c] = { char: c, label: c, description: `Type the lowercase letter "${c}".` };
    const u = c.toUpperCase();
    keys[`shift_${c}`] = { char: u, label: u, description: `Type the uppercase letter "${u}".` };
  }
  for (const d of '0123456789') keys[`digit_${d}`] = { char: d, label: d, description: `Type the digit "${d}".` };
  for (const [id, [char, name]] of Object.entries(PUNCTUATION)) keys[id] = { char, label: char, description: `Type the ${name} "${char}".` };
  keys.space = { char: ' ', label: 'space', description: 'Type a space between words.' };
  keys.newline = { char: '\n', label: 'return', description: 'Start a new line inside the reply (does not send it).' };
  keys.backspace = { action: 'backspace', label: 'backspace', description: 'Delete the last character typed so far, to fix a mistake.' };
  keys.send = { action: 'send', label: 'SEND', description: 'The reply is complete: send it to the user. Choose this only when the typed reply is finished.' };
  return keys;
})();

export const MAX_BACKSPACES = 6;
export const MAX_WORD_REPEATS = 3;
export const MAX_WORDS = 12;
const CONTRACTION_ENDINGS = ['s', 't', 'm', 'd', 'll', 're', 've'];

export const INSTRUCTIONS = [
  'You are Jev, chatting with the user by typing on a keyboard, one key per turn.',
  'state.conversation holds the chat so far; state.reply_typed_so_far is the reply you are typing right now to the user\'s latest message.',
  'Each option shows your whole reply as it will read after pressing that key (⏎ marks a new line).',
  'Pick the option whose result reads as the natural next step of a short, correctly spelled, helpful answer.',
  'state.answer_word is the answer you already chose for this reply: make sure the reply contains it.',
  'Follow state.goal_for_this_reply. Finish the word in state.current_word, then continue with the next word.',
  'Options named word:... type a whole word at once (completing the word being typed); prefer one when it is the word you want.',
  'Replies are short: usually 1 to 10 words. Start with the answer itself; do not begin by repeating words from the user\'s question.',
  'Never pad with filler words; choose send as soon as the reply answers the user.',
].join(' ');

export function applyKey(draft, id) {
  const key = KEYS[id];
  if (!key) throw new Error(`Unknown key ${id}`);
  if (key.action === 'backspace') return Array.from(draft).slice(0, -1).join('');
  if (key.action === 'send') return draft;
  return draft + key.char;
}

// Keys offered for this step. Removes moves that only produce loops seen in
// the logs: double spaces, deleting a space, backspace after backspace,
// sending an empty reply, and retyping a character already deleted at this
// position (rejected: prefix -> Set of deleted characters).
export function legalKeys(draft, { lastKey = null, backspaces = 0, rejected = new Map() } = {}) {
  const last = draft.at(-1);
  const tried = rejected.get(draft);
  // A word being finished that repeats one of the previous 2 words (ignoring a
  // plural/possessive s), or appears a 4th time, can't be ended.
  const words = wordsIn(draft), current = trailingWord(draft);
  const stem = w => w.replace(/'?s$/, '');
  const repeats = current !== '' && (words.slice(-3, -1).some(w => stem(w) === stem(current)) || words.filter(w => w === current).length > MAX_WORD_REPEATS);
  const tooLong = words.length >= MAX_WORDS;
  const afterApostrophe = draft.match(/[A-Za-z]'([A-Za-z]*)$/)?.[1].toLowerCase() ?? null;
  const keys = Object.keys(KEYS).filter(id => {
    if (tried?.has(KEYS[id].char)) return false;
    if (repeats && id !== 'backspace' && !/^[A-Za-z']$/.test(KEYS[id].char || '')) return false;
    if (id.startsWith('shift_') && /[a-z]$/.test(draft)) return false; // no capital mid-word
    if (id === 'apostrophe') return /[A-Za-z]$/.test(draft) && !/'[A-Za-z]*$/.test(draft);
    if (afterApostrophe !== null && /^[A-Za-z]$/.test(KEYS[id].char || '')) return CONTRACTION_ENDINGS.some(e => e.startsWith(afterApostrophe + KEYS[id].char.toLowerCase()));
    if (id === 'space') return draft !== '' && last !== ' ' && last !== '\n' && !tooLong;
    if (id === 'newline') return draft !== '' && last !== '\n' && !tooLong;
    if (id === 'backspace') return draft !== '' && last !== ' ' && lastKey !== 'backspace' && backspaces < MAX_BACKSPACES;
    if (id === 'send') return draft.trim() !== '';
    return true;
  });
  // The rules can combine to leave nothing (seen live: HTTP 400). Always leave a way out.
  return keys.length ? keys : ['backspace', 'send'];
}

// Plain spaces read as English; measured better than a visible space marker.
const shown = text => JSON.stringify(text.replace(/\n/g, '⏎')) + (text.endsWith(' ') ? ' (ends with a space)' : '');

// Spelling hint: which words a letter leads to, or whether a word-ending key
// finishes a real word.
const trailingNumber = text => text.match(/\d[\d.,]*$/)?.[0] || '';

export function wordHint(id, draft, vocab) {
  if (!vocab || id === 'backspace') return '';
  const key = KEYS[id];
  // Numbers: say which number a digit (or decimal point) builds, and which
  // number any other key finishes. Without this, digits looked like dead ends.
  if (/^\d$/.test(key.char || '') || (key.char === '.' && /\d$/.test(draft))) {
    const n = trailingNumber(draft + key.char);
    return key.char === '.' ? ` (decimal point: the number becomes "${n}")` : ` (the number becomes "${n}")`;
  }
  const number = trailingNumber(draft);
  if (number && /\d$/.test(draft)) return ` (finishes the number "${number}")`;
  if (/^[A-Za-z']$/.test(key.char || '')) {
    const w = trailingWord(draft + key.char);
    if (!w) return '';
    const starts = vocab.filter(v => v.startsWith(w)).sort((a, b) => (b === w) - (a === w)).slice(0, 5);
    return starts.length ? ` (leads to: ${starts.join(', ')})` : ` (no English word starts with "${w}")`;
  }
  const w = trailingWord(draft);
  if (!w) return '';
  return vocab.includes(w) ? ` (finishes the word "${w}")` : ` (leaves "${w}" unfinished: not a word)`;
}

export function describeKey(id, draft, vocab) {
  if (id === 'send') return `SEND the reply as it is now (${wordsIn(draft).length} words): ${JSON.stringify(draft)}${wordHint(id, draft, vocab)}`;
  return `${KEYS[id].description.replace(/\.$/, '')} → reply reads ${shown(applyKey(draft, id))}${wordHint(id, draft, vocab)}`;
}

// Replace the partial word (letters, digits, apostrophes) at the end of the
// draft with a whole word, followed by a space.
export function applyWord(draft, word) {
  let base = draft.replace(/[A-Za-z0-9']+$/, '');
  if (base && !/\s$/.test(base)) base += ' ';
  return base + word + ' ';
}

// Whole-word options: the chosen answer word (until it's in the reply), then
// predictor completions. Predictions are only offered once a word is started:
// next-word guesses at a word start were filler and echoes that Jev picked
// over better first letters (measured: iter13). All follow the word rules:
// nothing past the word cap, no word repeating either of the previous 2.
export function wordOptions(draft, predictor, answer = null) {
  const words = wordsIn(draft);
  const atStart = draft === '' || /\s$/.test(draft);
  const done = atStart ? words : words.slice(0, -1);
  if (done.length >= MAX_WORDS) return [];
  const partial = atStart ? '' : (draft.match(/[A-Za-z0-9']+$/)?.[0] || '').toLowerCase();
  const stem = w => w.replace(/'?s$/, '');
  const options = [];
  const typed = (draft.match(/[A-Za-z0-9']+/g) || []).map(w => w.toLowerCase());
  if (answer && !typed.slice(0, atStart ? undefined : -1).includes(answer.toLowerCase()) && answer.toLowerCase().startsWith(partial) && (atStart || partial)) options.push(answer);
  if (predictor && /[A-Za-z']$/.test(draft)) options.push(...predictor.suggest(draft));
  const seen = new Set();
  const first = !/[A-Za-z0-9]/.test(draft.replace(/[A-Za-z0-9']+$/, '')); // the reply's first word
  return options
    .map(w => (first ? w[0].toUpperCase() + w.slice(1) : w))
    .filter(w => !seen.has(w.toLowerCase()) && seen.add(w.toLowerCase()))
    .filter(w => !done.slice(-2).some(d => stem(d) === stem(norm(w))))
    .map(w => [`word:${w}`, `Type the whole ${w.toLowerCase() === answer?.toLowerCase() ? 'answer ' : ''}word "${w}" → reply reads ${shown(applyWord(draft, w))}`]);
}

export function applyChoice(draft, id) {
  return id.startsWith('word:') ? applyWord(draft, id.slice(5)) : applyKey(draft, id);
}

// Answer step: before typing, Jev picks the key word of its reply from ~5.5k
// candidates. One question may list at most 255 options, so candidates are
// split into groups of 250 (asked in parallel); the group winners then meet in
// a final question. Jev knows answers as whole words (3x4 -> 12 at ~100%) that
// it can't reach one letter at a time.
export const ANSWER_GROUP = 250;
export const NO_ANSWER = 'NONE';
const SKIP_ANSWER = new Set(['greet', 'goodbye', 'repeat']);
export const needsAnswer = goalId => !SKIP_ANSWER.has(goalId);
export function buildAnswerRequest({ history, goal, candidates, model = MODEL }) {
  return {
    model,
    state: { conversation: history.map(m => ({ speaker: m.role === 'jev' ? 'Jev (you)' : 'user', text: m.text })), ...(goal ? { goal_for_this_reply: goal } : {}) },
    questions: { answer: { type: 'choice', instructions: 'You are Jev, about to reply to the user\'s latest message. Choose the single key word of your reply: for a question, the answer itself (a number, name or word). If the exact answer is not in the list, choose NONE and you will type it yourself.', criteria: { ...Object.fromEntries(candidates.map(w => [w, w])), [NO_ANSWER]: 'The exact answer is not in this list; I will type it myself.' } } },
  };
}

export function buildRequest({ history, draft, keystrokes, maxKeystrokes, goal = null, answer = null, lastKey = null, backspaces = 0, rejected, vocab = vocabulary(history), predictor = null, model = MODEL }) {
  const words = draft.split(/\s+/).filter(Boolean);
  const endsWord = draft === '' || /\s$/.test(draft);
  return {
    model,
    state: {
      conversation: history.map(m => ({ speaker: m.role === 'jev' ? 'Jev (you)' : 'user', text: m.text })),
      ...(goal ? { goal_for_this_reply: goal } : {}),
      ...(answer ? { answer_word: answer } : {}),
      reply_typed_so_far: draft,
      words_completed: endsWord ? words : words.slice(0, -1),
      current_word: endsWord ? '' : words.at(-1),
      word_count: words.length,
      last_character: draft === '' ? 'nothing typed yet' : draft.at(-1) === ' ' ? 'space' : draft.at(-1) === '\n' ? 'newline' : draft.at(-1),
      keystrokes_used: keystrokes,
      keystrokes_remaining: maxKeystrokes - keystrokes,
    },
    questions: { key: { type: 'choice', instructions: INSTRUCTIONS,
      criteria: Object.fromEntries([...wordOptions(draft, predictor, answer), ...legalKeys(draft, { lastKey, backspaces, rejected }).map(id => [id, describeKey(id, draft, vocab)])]) } },
  };
}

// Plan step: before typing, Jev chooses what the reply should do. The chosen
// goal is included in every keystroke request.
export const GOALS = {
  greet: 'Greet the user back briefly.',
  introduce: 'Say who you are: you are Jev.',
  answer: 'Answer the user\'s question directly with the fact, in a few words.',
  repeat: 'Type exactly the words the user asked you to say or repeat, nothing else.',
  feeling: 'Say how you are doing, e.g. that you are good.',
  support: 'Be kind and give one short, simple suggestion.',
  ask: 'Ask the user a short question back.',
  correction: 'Accept the user\'s correction: say sorry or that they are right.',
  goodbye: 'Say goodbye briefly.',
  chat: 'Reply naturally in a few words.',
};

export function buildPlanRequest({ history, model = MODEL }) {
  return {
    model,
    state: { conversation: history.map(m => ({ speaker: m.role === 'jev' ? 'Jev (you)' : 'user', text: m.text })) },
    questions: { plan: { type: 'choice', instructions: 'You are Jev, about to type a reply to the user\'s latest message. Choose what your reply should do.', criteria: GOALS } },
  };
}

// Checks the JEV response contract: expected model, usage, and a choice from the offered options.
export function validateResponse(data, request) {
  if (!data || data.model !== request.model) throw new Error('Unexpected JEV model version');
  const u = data.usage;
  if (!u || !Number.isSafeInteger(u.input_tokens) || u.input_tokens < 0 || !Number.isSafeInteger(u.output_tokens) || u.output_tokens < 0) throw new Error('Missing or invalid provider usage');
  for (const [name, question] of Object.entries(request.questions)) {
    const answer = data.answers?.[name];
    if (!answer || answer.type !== 'choice' || typeof answer.choice !== 'string' || !Object.hasOwn(question.criteria, answer.choice)) throw new Error(name === 'key' ? 'JEV returned a key outside the keyboard' : `JEV returned a ${name} outside the offered options`);
    if (!Number.isFinite(answer.confidence) || answer.confidence < 0 || answer.confidence > 1) throw new Error('Invalid choice confidence');
  }
  return data;
}

export const redact = s => String(s).replace(/apikey_[A-Za-z0-9_]+/g, '[redacted]').slice(0, 400);

async function requestJev({ request, key, fetchImpl, signal, timeoutMs, log, n }) {
  log({ event: 'jev_request', n, endpoint: ENDPOINT, request });
  const started = Date.now();
  let httpStatus = null, raw;
  const controller = new AbortController();
  const onAbort = () => controller.abort(signal.reason);
  signal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(new DOMException('JEV request timed out', 'TimeoutError')), timeoutMs);
  try {
    const response = await fetchImpl(ENDPOINT, {
      method: 'POST', redirect: 'error', signal: controller.signal,
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    });
    httpStatus = response.status;
    try { raw = await response.json(); } catch { throw new Error(`JEV returned non-JSON (HTTP ${response.status})`); }
    if (!response.ok) {
      const retry = response.headers?.get?.('retry-after');
      throw Object.assign(new Error(`JEV HTTP ${response.status}${retry ? `; Retry-After ${String(retry).slice(0, 30)}` : ''}`), { usage: raw?.usage });
    }
    validateResponse(raw, request);
    log({ event: 'jev_response', n, httpStatus, latencyMs: Date.now() - started, response: raw });
    return raw;
  } catch (error) {
    log({ event: 'jev_error', n, httpStatus, latencyMs: Date.now() - started, error: redact(error.message), aborted: !!signal?.aborted, response: raw ?? null });
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

// Runs the keystroke loop. Calls onEvent for every keystroke and returns the
// final outcome: { reason: 'send' | 'cap' | 'stopped' | 'budget', text, ... }.
export async function typeReply({ history, key, fetchImpl = fetch, signal, maxKeystrokes = 400, budgetMicroT = Infinity, timeoutMs = DEFAULT_TIMEOUT_MS, model = MODEL, plan = true, predictWords = true, pickAnswer = true, onEvent = () => {}, onPlan = () => {}, onAnswer = () => {}, log = () => {} }) {
  if (!key) throw new Error('TYPESAFE_API_KEY is not configured on the server.');
  let draft = '', keystrokes = 0, inputTokens = 0, outputTokens = 0, lastKey = null, backspaces = 0;
  const rejected = new Map(), vocab = vocabulary(history), predictor = predictWords ? createPredictor(history) : null;
  let goal = null, goalId = null, answer = null;
  const totals = () => ({ text: draft, keystrokes, inputTokens, outputTokens, costUSD: inputTokens * INPUT_MICROT * 1e-9, ...(goalId ? { goal: goalId } : {}), ...(answer ? { answer } : {}) });
  const call = async (request, n) => {
    try {
      const data = await requestJev({ request, key, fetchImpl, signal, timeoutMs, log, n });
      inputTokens += data.usage.input_tokens;
      outputTokens += data.usage.output_tokens;
      return data;
    } catch (error) {
      if (signal?.aborted) return null;
      if (error.usage && Number.isSafeInteger(error.usage.input_tokens)) inputTokens += error.usage.input_tokens;
      throw Object.assign(new Error(redact(error.message)), { partial: totals() });
    }
  };
  if (plan) {
    const planRequest = buildPlanRequest({ history, model });
    const data = await call(planRequest, 0);
    if (!data || signal?.aborted) return { reason: 'stopped', ...totals() };
    goalId = data.answers.plan.choice;
    goal = GOALS[goalId];
    onPlan({ goal: goalId, description: goal, confidence: data.answers.plan.confidence, request: planRequest, response: data });
  }
  if (pickAnswer && needsAnswer(goalId)) {
    const candidates = answerCandidates(history), groups = [];
    for (let i = 0; i < candidates.length; i += ANSWER_GROUP) groups.push(candidates.slice(i, i + ANSWER_GROUP));
    const winners = await Promise.all(groups.map((g, i) => call(buildAnswerRequest({ history, goal, candidates: g, model }), `answer-${i + 1}`)));
    if (winners.some(w => !w) || signal?.aborted) return { reason: 'stopped', ...totals() };
    // Groups that don't hold the answer can say NONE; if all do, Jev types it itself.
    const finalists = [...new Set(winners.map(w => w.answers.answer.choice))].filter(w => w !== NO_ANSWER);
    if (finalists.length) {
      const finalRequest = buildAnswerRequest({ history, goal, candidates: finalists, model });
      const data = await call(finalRequest, 'answer-final');
      if (!data || signal?.aborted) return { reason: 'stopped', ...totals() };
      const choice = data.answers.answer.choice;
      answer = choice === NO_ANSWER ? null : choice;
      onAnswer({ answer: answer ?? NO_ANSWER, confidence: data.answers.answer.confidence, candidates: candidates.length, groups: groups.length, finalists, request: finalRequest, response: data });
    } else {
      onAnswer({ answer: NO_ANSWER, confidence: null, candidates: candidates.length, groups: groups.length, finalists: [], request: null, response: null });
    }
  }
  while (true) {
    if (signal?.aborted) return { reason: 'stopped', ...totals() };
    if (keystrokes >= maxKeystrokes) return { reason: 'cap', ...totals() };
    if (inputTokens * INPUT_MICROT >= budgetMicroT) return { reason: 'budget', ...totals() };
    const request = buildRequest({ history, draft, keystrokes, maxKeystrokes, goal, answer, lastKey, backspaces, rejected, vocab, predictor, model });
    const data = await call(request, keystrokes + 1);
    if (!data || signal?.aborted) return { reason: 'stopped', ...totals() };
    keystrokes++;
    const id = data.answers.key.choice;
    if (id === 'backspace') {
      const prefix = Array.from(draft).slice(0, -1).join('');
      rejected.set(prefix, new Set([...(rejected.get(prefix) || []), Array.from(draft).at(-1)]));
    }
    draft = applyChoice(draft, id);
    lastKey = id;
    if (id === 'backspace') backspaces++;
    onEvent({ key: id, label: KEYS[id]?.label ?? id.slice(5), confidence: data.answers.key.confidence, ...totals(), request, response: data });
    if (id === 'send') return { reason: 'send', ...totals() };
  }
}
