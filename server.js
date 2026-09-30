import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync, mkdirSync, appendFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { typeReply, KEYS, MODEL, redact } from './jev-typist.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const MAX_BODY = 200_000;
const MAX_HISTORY = 40;

export function createApp({ key, logDir = path.join(here, 'logs'), fetchImpl = fetch, maxKeystrokes = 400, budgetUSD = 0.5, model = MODEL, timeoutMs } = {}) {
  let busy = false;
  return http.createServer(async (req, res) => {
    try {
      if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(await readFile(path.join(here, 'public/index.html')));
      }
      if (req.method === 'GET' && req.url === '/api/config') {
        return json(res, 200, { keyConfigured: !!key, model, maxKeystrokes, budgetUSD, keys: Object.fromEntries(Object.entries(KEYS).map(([id, k]) => [id, k.label])) });
      }
      if (req.method === 'POST' && req.url === '/api/reply') return reply(req, res);
      json(res, 404, { error: 'Not found' });
    } catch (error) {
      if (!res.headersSent) json(res, 500, { error: redact(error.message) });
      else res.end();
    }
  });

  async function reply(req, res) {
    if (!key) return json(res, 503, { error: 'TYPESAFE_API_KEY is not set. Add it to .env (see .env.example) and restart the server.' });
    if (busy) return json(res, 409, { error: 'Jev is already typing a reply.' });
    let body;
    try { body = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: 'Invalid JSON body' }); }
    const history = Array.isArray(body?.history) ? body.history.slice(-MAX_HISTORY) : null;
    if (!history?.length || !history.every(m => (m?.role === 'user' || m?.role === 'jev') && typeof m.text === 'string') || history.at(-1).role !== 'user') {
      return json(res, 400, { error: 'history must be a list of {role:"user"|"jev", text} ending with a user message' });
    }

    busy = true;
    const replyId = randomUUID();
    const log = entry => writeLog(logDir, { ts: new Date().toISOString(), replyId, ...entry });
    log({ event: 'reply_start', model, maxKeystrokes, budgetUSD, history });
    const controller = new AbortController();
    // Stop button (or closing the tab) closes the stream, which aborts the loop.
    res.on('close', () => controller.abort(new Error('client disconnected')));
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    const send = (event, data) => { if (!res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); };
    try {
      const result = await typeReply({ history, key, fetchImpl, model, timeoutMs, maxKeystrokes, budgetMicroT: budgetUSD * 1e9, signal: controller.signal, log, onPlan: ({ request, response, ...p }) => { log({ event: 'plan', ...p }); send('plan', { ...p, request, response }); }, onAnswer: ({ request, response, ...a }) => { log({ event: 'answer', ...a }); send('answer', { ...a, request, response }); }, onEvent: ({ request, response, ...e }) => { log({ event: 'keystroke', ...e }); send('key', { ...e, request, response }); } });
      log({ event: 'reply_end', ...result });
      send('done', result);
    } catch (error) {
      log({ event: 'reply_error', error: redact(error.message), ...(error.partial || {}) });
      send('error', { error: redact(error.message), ...(error.partial || {}) });
    } finally {
      busy = false;
      res.end();
    }
  }
}

// Append-only JSONL, one file per day, in logs/ (git-ignored; never commit).
// Records every JEV request body as sent; the Authorization header is never logged.
function writeLog(dir, entry) {
  try {
    mkdirSync(dir, { recursive: true });
    const line = JSON.stringify(entry).replace(/apikey_[A-Za-z0-9_]+/g, '[redacted]');
    appendFileSync(path.join(dir, `${entry.ts.slice(0, 10)}.jsonl`), line + '\n');
  } catch (error) {
    console.error('Could not write log:', error.message);
  }
}

function json(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > MAX_BODY) { reject(new Error('Body too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  // Env: real environment first, then ./.env.
  if (existsSync(path.join(here, '.env'))) process.loadEnvFile(path.join(here, '.env'));
  const port = Number(process.env.JEV_CHAT_PORT || 4317);
  const key = process.env.TYPESAFE_API_KEY?.trim() || '';
  const app = createApp({
    key,
    model: process.env.JEV_MODEL || MODEL,
    maxKeystrokes: Number(process.env.JEV_CHAT_MAX_KEYSTROKES || 400),
    budgetUSD: Number(process.env.JEV_CHAT_MAX_USD_PER_REPLY || 0.5),
    timeoutMs: Number(process.env.JEV_REQUEST_TIMEOUT_MS || 30000),
  });
  app.listen(port, '127.0.0.1', () => {
    console.log(`Jev keyboard chat on http://localhost:${port}`);
    if (!key) console.log('TYPESAFE_API_KEY is not set; the page will show a configuration error.');
  });
}
