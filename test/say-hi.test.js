import test from 'node:test';
import assert from 'node:assert/strict';
import { typeReply, applyKey, buildRequest, legalKeys, describeKey, vocabulary, wordOptions, applyWord, ANSWER_GROUP, NO_ANSWER, GOALS, KEYS, MODEL, ENDPOINT, MAX_BACKSPACES } from '../jev-typist.js';
import { createApp } from '../server.js';
import { createPredictor } from '../predictor.js';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Mocked TypeSafe endpoint: answers each request with the next scripted key.
// Plan requests are answered with `goal` and recorded in planCalls, answer
// tournament requests with `answer` (when offered, else the first option) in
// answerCalls; only keystroke requests go in calls. Default goal 'greet' skips
// the answer step.
function scripted(keys, { usage = { input_tokens: 1000, output_tokens: 1 }, goal = 'greet', answer = null } = {}) {
  const calls = [], planCalls = [], answerCalls = [];
  const fetchImpl = async (url, init) => {
    const request = JSON.parse(init.body);
    let answers;
    if (request.questions.plan) {
      planCalls.push({ url, init, body: request });
      answers = { plan: { type: 'choice', choice: goal, confidence: 0.8, probabilities: {} } };
    } else if (request.questions.answer) {
      answerCalls.push({ url, init, body: request });
      const options = Object.keys(request.questions.answer.criteria);
      answers = { answer: { type: 'choice', choice: options.includes(answer) ? answer : options[0], confidence: 0.9, probabilities: {} } };
    } else {
      calls.push({ url, init, body: request });
      answers = { key: { type: 'choice', choice: keys[Math.min(calls.length - 1, keys.length - 1)], confidence: 0.9, probabilities: {} } };
    }
    const body = { model: MODEL, usage, answers };
    return { ok: true, status: 200, headers: new Headers(), json: async () => body };
  };
  return { fetchImpl, calls, planCalls, answerCalls };
}

const history = [{ role: 'user', text: 'hi' }];

test('keyboard covers letters, digits, punctuation, space, backspace, newline and send', () => {
  for (const id of ['a', 'shift_z', 'digit_0', 'period', 'question', 'space', 'backspace', 'newline', 'send']) assert.ok(KEYS[id], id);
  const req = buildRequest({ history, draft: 'I am j', keystrokes: 1, maxKeystrokes: 10 });
  assert.equal(req.model, MODEL);
  assert.equal(req.questions.key.type, 'choice');
  assert.deepEqual(Object.keys(req.questions.key.criteria), legalKeys('I am j'));
  const offered = new Set([...legalKeys(''), ...legalKeys('I am j'), ...legalKeys('Hi')]);
  assert.deepEqual(Object.keys(KEYS).filter(id => !offered.has(id)), []);
  assert.equal(req.state.reply_typed_so_far, 'I am j');
  assert.equal(req.state.current_word, 'j');
  assert.deepEqual(req.state.words_completed, ['I', 'am']);
  assert.equal(req.state.conversation[0].speaker, 'user');
  assert.match(req.questions.key.criteria.e, /reply reads "I am je"/);
  assert.match(req.questions.key.criteria.send, /"I am j"/);
});

test('loop rules drop keys that only produce loops', () => {
  const empty = legalKeys('');
  for (const id of ['space', 'newline', 'backspace', 'send']) assert.ok(!empty.includes(id), id);
  const afterSpace = legalKeys('I ');
  assert.ok(!afterSpace.includes('space') && !afterSpace.includes('backspace') && afterSpace.includes('send') && afterSpace.includes('a'));
  assert.ok(!legalKeys('Ix', { lastKey: 'backspace' }).includes('backspace'));
  assert.ok(!legalKeys('Ix', { backspaces: MAX_BACKSPACES }).includes('backspace'));
  assert.ok(legalKeys('Ix', { lastKey: 'x', backspaces: 1 }).includes('backspace'));
  const afterDelete = legalKeys('I m a J', { lastKey: 'e', backspaces: 1, rejected: new Map([['I m a J', new Set(['v'])]]) });
  assert.ok(!afterDelete.includes('v') && afterDelete.includes('e'));
  assert.equal(describeKey('newline', 'a b'), 'Start a new line inside the reply (does not send it) → reply reads "a b⏎"');
});

test('spelling hints use common words and the user\'s own words', () => {
  const vocab = vocabulary([{ role: 'user', text: 'say boom' }, { role: 'jev', text: 'bomb' }]);
  assert.match(describeKey('o', 'bo', vocab), /leads to: boom/);
  assert.match(describeKey('m', 'bo', vocab), /no English word starts with "bom"/);
  assert.match(describeKey('space', 'I am boom', vocab), /finishes the word "boom"/);
  assert.match(describeKey('send', 'bom', vocab), /not a word/);
  assert.ok(!vocab.includes('bomb'));
  const chat = [{ role: 'user', text: 'who are you?' }, { role: 'jev', text: 'Jev' }, { role: 'user', text: 'repeat after me: I am Jev' }];
  assert.match(describeKey('a', 'I ', vocabulary(chat)), /leads to: a, after, am/);
});

test('apostrophe only once per word, after a letter', () => {
  assert.ok(legalKeys('I').includes('apostrophe'));
  assert.ok(!legalKeys('I ').includes('apostrophe'));
  assert.ok(!legalKeys("ate'").includes('apostrophe'));
  assert.ok(!legalKeys("don't").includes('apostrophe'));
  // After an apostrophe only contraction/possessive endings: 's 't 'm 'd 'll 're 've.
  const afterApostrophe = legalKeys("sa'");
  assert.ok(afterApostrophe.includes('s') && afterApostrophe.includes('l') && !afterApostrophe.includes('y'));
  assert.ok(legalKeys("we'l").includes('l') && !legalKeys("we'l").includes('s'));
  assert.ok(!legalKeys("and's").includes('s') && legalKeys("and's").includes('space'));
  // Seen live: every rule at once left no keys and TypeSafe returned HTTP 400.
  assert.deepEqual(legalKeys("Is jev A am am's", { lastKey: 's', backspaces: MAX_BACKSPACES }), ['backspace', 'send']);
});

test('repeated filler words cannot be finished', () => {
  const afterRepeat = legalKeys('I am a a');
  assert.ok(!afterRepeat.includes('space') && !afterRepeat.includes('send') && afterRepeat.includes('backspace') && afterRepeat.includes('n'));
  assert.ok(!legalKeys('a b a c a d a').includes('space'));
  assert.ok(legalKeys('a b c a').includes('space'));
  assert.ok(!legalKeys('an anyone an anyone').includes('space'));
  assert.ok(!legalKeys("cat says cat's").includes('send'));
  assert.ok(legalKeys('take a walk and a').includes('space'));
  const twelve = legalKeys('one two three four five six seven eight nine ten eleven twelve');
  assert.ok(!twelve.includes('space') && twelve.includes('send') && twelve.includes('period'));
});

test('number hints show the number being built or finished', () => {
  const vocab = vocabulary(history);
  assert.match(describeKey('digit_9', 'it is 1', vocab), /the number becomes "19"\)/);
  assert.match(describeKey('period', 'it is 1', vocab), /decimal point: the number becomes "1\."/);
  assert.match(describeKey('digit_5', 'it is 1.', vocab), /the number becomes "1\.5"/);
  assert.match(describeKey('space', 'it is 19', vocab), /finishes the number "19"/);
  assert.match(describeKey('send', '2000', vocab), /finishes the number "2000"/);
  assert.match(describeKey('period', 'I am Jev', vocab), /finishes the word "jev"/);
});

test('whole-word options from the predictor', async () => {
  const boom = [{ role: 'user', text: 'say boom' }];
  const req = buildRequest({ history: boom, draft: 'bo', keystrokes: 2, maxKeystrokes: 10, predictor: createPredictor(boom) });
  assert.equal(Object.keys(req.questions.key.criteria)[0], 'word:Boom');
  assert.match(req.questions.key.criteria['word:Boom'], /reply reads "Boom " \(ends with a space\)/);
  // No word option repeating either of the previous 2 words, none past the word cap.
  const sky = [{ role: 'user', text: 'what color is the sky?' }];
  const offered = Object.keys(buildRequest({ history: sky, draft: 'The sky is s', keystrokes: 3, maxKeystrokes: 10, predictor: createPredictor(sky) }).questions.key.criteria);
  assert.ok(offered.includes('word:so') && !offered.includes('word:sky'));
  assert.deepEqual(wordOptions('The sky is ', createPredictor(sky)), []);
  assert.deepEqual(wordOptions('one two three four five six seven eight nine ten eleven twelve t', createPredictor(sky)), []);
  const { fetchImpl } = scripted(['b', 'o', 'word:Boom', 'send']);
  const events = [];
  const result = await typeReply({ history: boom, key: 'k', fetchImpl, onEvent: e => events.push(e) });
  assert.equal(result.text, 'Boom ');
  assert.equal(events[2].label, 'Boom');
});

test('answer step: tournament picks the answer word, then it is offered while typing', async () => {
  const math = [{ role: 'user', text: 'what is 3x4' }];
  const { fetchImpl, calls, answerCalls } = scripted(['word:12', 'send'], { goal: 'answer', answer: '12' });
  const answers = [];
  const result = await typeReply({ history: math, key: 'k', fetchImpl, onAnswer: a => answers.push(a) });
  assert.equal(result.text, '12 ');
  assert.equal(result.answer, '12');
  // Groups of at most 250 options (TypeSafe allows 255), then one final.
  const groups = answerCalls.slice(0, -1);
  assert.ok(groups.length >= 30 && groups.every(c => Object.keys(c.body.questions.answer.criteria).length <= Math.min(255, ANSWER_GROUP + 1)));
  const final = answerCalls.at(-1).body.questions.answer.criteria;
  assert.equal(Object.keys(final).length, groups.length + 1); // winners + NONE
  assert.ok(Object.hasOwn(final, '12') && Object.hasOwn(final, NO_ANSWER));
  assert.equal(answers[0].answer, '12');
  assert.equal(calls[0].body.state.answer_word, '12');
  assert.match(calls[0].body.questions.key.criteria['word:12'], /whole answer word "12"/);
  // Every group answering NONE: no answer word, Jev types it itself.
  const none = scripted(['digit_1', 'send'], { goal: 'answer', answer: NO_ANSWER });
  const noneResult = await typeReply({ history: math, key: 'k', fetchImpl: none.fetchImpl });
  assert.equal(noneResult.answer, undefined);
  assert.equal(none.calls[0].body.state.answer_word, undefined);
  assert.ok(none.answerCalls.every(c => Object.hasOwn(c.body.questions.answer.criteria, NO_ANSWER)));
  // Greetings, goodbyes and repeats skip the tournament.
  const skip = scripted(['shift_h', 'i', 'send'], { goal: 'greet' });
  await typeReply({ history, key: 'k', fetchImpl: skip.fetchImpl });
  assert.equal(skip.answerCalls.length, 0);
});

test('answer word option: offered at word starts or when the partial matches, until typed', () => {
  assert.deepEqual(wordOptions('', null, '12').map(o => o[0]), ['word:12']);
  assert.deepEqual(wordOptions('', null, 'jev').map(o => o[0]), ['word:Jev']);
  assert.deepEqual(wordOptions('I am ', null, 'jev').map(o => o[0]), ['word:jev']);
  assert.deepEqual(wordOptions('1', null, '12').map(o => o[0]), ['word:12']);
  assert.deepEqual(wordOptions('Tw', null, '12'), []);
  assert.deepEqual(wordOptions('It is 12 ', null, '12'), []);
  assert.equal(applyWord('It is 1', '12'), 'It is 12 ');
  assert.equal(applyWord('Hi,', 'there'), 'Hi, there ');
});

test('no capital letter in the middle of a word', () => {
  assert.ok(!legalKeys('ca').includes('shift_l') && legalKeys('ca').includes('l'));
  assert.ok(legalKeys('I am ').includes('shift_j') && legalKeys('I').includes('shift_m'));
});

test('applyKey types, deletes and sends', () => {
  assert.equal(applyKey('H', 'shift_i'), 'HI');
  assert.equal(applyKey('Hi', 'backspace'), 'H');
  assert.equal(applyKey('', 'backspace'), '');
  assert.equal(applyKey('Hi', 'space'), 'Hi ');
  assert.equal(applyKey('Hi', 'send'), 'Hi');
});

test('loops until SEND, sending the draft each time', async () => {
  const { fetchImpl, calls, planCalls } = scripted(['shift_h', 'i', 'x', 'backspace', 'exclamation', 'send'], { goal: 'greet' });
  const events = [], plans = [];
  const result = await typeReply({ history, key: 'test-key', fetchImpl, onEvent: e => events.push(e), onPlan: p => plans.push(p) });
  assert.equal(result.reason, 'send');
  assert.equal(result.text, 'Hi!');
  assert.equal(result.keystrokes, 6);
  assert.equal(result.inputTokens, 7000);
  assert.equal(result.goal, 'greet');
  assert.equal(planCalls.length, 1);
  assert.deepEqual(Object.keys(planCalls[0].body.questions.plan.criteria), Object.keys(GOALS));
  assert.equal(plans[0].goal, 'greet');
  assert.equal(calls[0].body.state.goal_for_this_reply, GOALS.greet);
  assert.equal(events.map(e => e.text).join('|'), 'H|Hi|Hix|Hi|Hi!|Hi!');
  assert.equal(calls[0].url, ENDPOINT);
  assert.equal(calls[0].init.headers.Authorization, 'Bearer test-key');
  assert.equal(calls[3].body.state.reply_typed_so_far, 'Hix');
});

test('stops at the keystroke cap', async () => {
  const { fetchImpl, calls } = scripted(['a']);
  const result = await typeReply({ history, key: 'k', fetchImpl, maxKeystrokes: 5 });
  assert.equal(result.reason, 'cap');
  assert.equal(result.text, 'aaaaa');
  assert.equal(calls.length, 5);
});

test('stops at the spend cap', async () => {
  const { fetchImpl, calls } = scripted(['a']);
  // 1000 tokens * 42 microT = 42000 microT per call; budget allows 3 calls: the plan and 2 keys.
  const result = await typeReply({ history, key: 'k', fetchImpl, budgetMicroT: 42000 * 3 });
  assert.equal(result.reason, 'budget');
  assert.equal(calls.length, 2);
});

test('abort signal stops the loop', async () => {
  const { fetchImpl } = scripted(['a']);
  const controller = new AbortController();
  const result = await typeReply({ history, key: 'k', fetchImpl, signal: controller.signal, onEvent: e => { if (e.keystrokes === 3) controller.abort(); } });
  assert.equal(result.reason, 'stopped');
  assert.equal(result.text, 'aaa');
});

test('cannot retype the character it just deleted', async () => {
  await assert.rejects(typeReply({ history, key: 'k', fetchImpl: scripted(['a', 'v', 'backspace', 'v']).fetchImpl }), /outside the keyboard/);
  // Still blocked later at the same position, after trying another letter.
  await assert.rejects(typeReply({ history, key: 'k', fetchImpl: scripted(['a', 'v', 'backspace', 'e', 'backspace', 'v']).fetchImpl }), /outside the keyboard/);
  const ok = await typeReply({ history, key: 'k', fetchImpl: scripted(['a', 'v', 'backspace', 'e', 'send']).fetchImpl });
  assert.equal(ok.text, 'ae');
});

test('rejects keys outside the offered menu and missing key', async () => {
  await assert.rejects(typeReply({ history, key: 'k', fetchImpl: scripted(['not_a_key']).fetchImpl }), /outside the keyboard/);
  await assert.rejects(typeReply({ history, key: 'k', fetchImpl: scripted(['a', 'space', 'space']).fetchImpl }), /outside the keyboard/);
  await assert.rejects(typeReply({ history, key: '', fetchImpl: scripted(['a']).fetchImpl }), /TYPESAFE_API_KEY/);
});

test('HTTP errors surface without a fallback and redact keys', async () => {
  const fetchImpl = async () => ({ ok: false, status: 401, headers: new Headers(), json: async () => ({ error: 'bad' }) });
  await assert.rejects(typeReply({ history, key: 'k', fetchImpl }), /JEV HTTP 401/);
});

async function withServer(opts, fn) {
  const app = createApp({ logDir: mkdtempSync(path.join(tmpdir(), 'jev-chat-log-')), ...opts });
  await new Promise(r => app.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.address().port}`;
  try { return await fn(base); } finally { app.closeAllConnections(); await new Promise(r => app.close(r)); }
}

test('server reports missing key as a configuration error', async () => {
  await withServer({ key: '' }, async base => {
    assert.equal((await (await fetch(`${base}/api/config`)).json()).keyConfigured, false);
    const res = await fetch(`${base}/api/reply`, { method: 'POST', body: JSON.stringify({ history }) });
    assert.equal(res.status, 503);
    assert.match((await res.json()).error, /TYPESAFE_API_KEY is not set/);
  });
});

test('server streams keystrokes over SSE and never exposes the key', async () => {
  const { fetchImpl } = scripted(['o', 'k', 'send']);
  await withServer({ key: 'secret-key', fetchImpl }, async base => {
    const page = await (await fetch(base)).text();
    assert.match(page, /Chat with Jev/);
    const config = await (await fetch(`${base}/api/config`)).text();
    assert.ok(!config.includes('secret-key'));
    const res = await fetch(`${base}/api/reply`, { method: 'POST', body: JSON.stringify({ history }) });
    assert.equal(res.headers.get('content-type'), 'text/event-stream');
    const text = await res.text();
    assert.equal((text.match(/event: key/g) || []).length, 3);
    assert.match(text, /event: done\ndata: \{"reason":"send","text":"ok"/);
    // Each streamed call carries the exact request sent and the response, for the side panel.
    const events = text.trim().split('\n\n').map(c => ({ event: c.match(/^event: (.*)$/m)[1], data: JSON.parse(c.match(/^data: (.*)$/m)[1]) }));
    const plan = events.find(e => e.event === 'plan'), keys = events.filter(e => e.event === 'key');
    assert.ok(plan.data.request.questions.plan && plan.data.response.answers.plan);
    assert.equal(keys[1].data.request.state.reply_typed_so_far, 'o');
    assert.equal(keys[1].data.response.answers.key.choice, 'k');
    assert.ok(!text.includes('secret-key'));
  });
});

test('server rejects malformed history', async () => {
  await withServer({ key: 'k', fetchImpl: scripted(['send']).fetchImpl }, async base => {
    const res = await fetch(`${base}/api/reply`, { method: 'POST', body: JSON.stringify({ history: [{ role: 'jev', text: 'x' }] }) });
    assert.equal(res.status, 400);
  });
});

test('server logs every JEV request and response as JSONL, without the key', async () => {
  const logDir = mkdtempSync(path.join(tmpdir(), 'jev-chat-log-'));
  const { fetchImpl } = scripted(['o', 'k', 'send']);
  await withServer({ key: 'apikey_secret_123', fetchImpl, logDir }, async base => {
    await (await fetch(`${base}/api/reply`, { method: 'POST', body: JSON.stringify({ history }) })).text();
  });
  const files = readdirSync(logDir);
  assert.equal(files.length, 1);
  const raw = readFileSync(path.join(logDir, files[0]), 'utf8');
  assert.ok(!raw.includes('apikey_secret_123'));
  const entries = raw.trim().split('\n').map(l => JSON.parse(l));
  const events = entries.map(e => e.event);
  assert.equal(events[0], 'reply_start');
  assert.equal(events.at(-1), 'reply_end');
  assert.equal(events.filter(e => e === 'jev_request').length, 4);
  assert.equal(events.filter(e => e === 'jev_response').length, 4);
  const second = entries.filter(e => e.event === 'jev_request')[2];
  assert.equal(second.request.state.reply_typed_so_far, 'o');
  assert.equal(second.request.model, MODEL);
  assert.ok(entries.every(e => e.replyId === entries[0].replyId && e.ts));
  assert.equal(entries.at(-1).text, 'ok');
  assert.ok(entries.filter(e => e.event === 'keystroke').every(e => !e.request && !e.response));
});
