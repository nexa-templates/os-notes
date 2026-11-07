import { accessUser, accessFailure, needsEditorAccess } from './access.js';
import { DurableObject } from 'cloudflare:workers';

const MAX_BODY = 110_000, MAX_NOTES = 100, MAX_TOTAL = 1_000_000;
const token = () => [...crypto.getRandomValues(new Uint8Array(32))].map(x => x.toString(16).padStart(2, '0')).join('');
const digest = async value => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))].map(x => x.toString(16).padStart(2, '0')).join('');
const json = (data, status = 200) => Response.json(data, { status });
const error = (message, status = 400) => json({ error: message }, status);
function noteValid(note) {
  return note && typeof note.title === 'string' && note.title.trim().length > 0 && note.title.length <= 160 && typeof note.body === 'string' && new TextEncoder().encode(note.body).length <= 100_000;
}

export class Notebook extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS notes (id TEXT PRIMARY KEY, title TEXT NOT NULL, body TEXT NOT NULL, version INTEGER NOT NULL, updatedAt INTEGER NOT NULL)');
  }
  get(key) { return this.sql.exec('SELECT value FROM meta WHERE key = ?', key).toArray()[0]?.value; }
  set(key, value) { this.sql.exec('INSERT OR REPLACE INTO meta VALUES (?, ?)', key, value); }
  snapshot(role) {
    return { name: this.get('name'), role, notes: this.sql.exec('SELECT * FROM notes ORDER BY updatedAt DESC, id').toArray() };
  }
  init(ownerHash, notes) {
    if (this.get('owner')) return error('Notebook already exists.', 409);
    this.ctx.storage.transactionSync(() => {
      this.set('owner', ownerHash); this.set('name', 'Team notebook');
      for (const [index, note] of notes.entries()) this.sql.exec('INSERT INTO notes VALUES (?, ?, ?, 1, ?)', crypto.randomUUID(), note.title.trim(), note.body, Date.now() - index);
    });
    return json(this.snapshot('owner'), 201);
  }
  async handle(method, path, secret, body) {
    const hash = await digest(secret);
    const role = ['owner', 'edit', 'view'].find(role => this.get(role) === hash);
    if (!role) return error('This notebook link is invalid or has been revoked.', 403);
    if (path === '' && method === 'GET') return json(this.snapshot(role));
    if (role === 'view') return error('This link allows viewing only.', 403);
    if (path === '/sharing' && method === 'POST') {
      if (role !== 'owner') return error('Only the notebook owner can manage sharing.', 403);
      if (!['edit', 'view'].includes(body?.role)) return error('Choose view or edit access.');
      const secret = token(), newHash = await digest(secret);
      // Recheck after the async digest: the owner may have deleted the notebook.
      if (this.get('owner') !== hash) return error('Notebook unavailable.', 403);
      this.set(body.role, newHash);
      return json({ token: secret, role: body.role });
    }
    if (path === '/sharing' && method === 'DELETE') {
      if (role !== 'owner') return error('Only the notebook owner can manage sharing.', 403);
      this.sql.exec("DELETE FROM meta WHERE key IN ('edit', 'view')");
      return json({ revoked: true });
    }
    if (path === '' && method === 'DELETE') {
      if (role !== 'owner') return error('Only the notebook owner can delete it.', 403);
      this.ctx.storage.transactionSync(() => { this.sql.exec('DELETE FROM notes'); this.sql.exec('DELETE FROM meta'); });
      return json({ deleted: true });
    }
    if (path === '/notes' && method === 'POST') {
      if (!noteValid(body)) return error('Use a title of 1–160 characters and a note smaller than 100 KB.');
      if (this.sql.exec('SELECT COUNT(*) AS count FROM notes').one().count >= MAX_NOTES) return error('This notebook has reached its 100-note limit.', 413);
      if (!this.fits(body.body)) return error('This notebook has reached its 1 MB limit.', 413);
      const note = { id: crypto.randomUUID(), title: body.title.trim(), body: body.body, version: 1, updatedAt: Date.now() };
      this.sql.exec('INSERT INTO notes VALUES (?, ?, ?, ?, ?)', note.id, note.title, note.body, note.version, note.updatedAt);
      return json(note, 201);
    }
    const match = /^\/notes\/([a-f0-9-]{36})$/.exec(path);
    if (!match || !['PUT', 'DELETE'].includes(method)) return error('Not found.', 404);
    const current = this.sql.exec('SELECT * FROM notes WHERE id = ?', match[1]).toArray()[0];
    if (!current) return error('This note has been deleted. Save your draft as a new note.', 404);
    if (body?.version !== current.version) return json({ error: 'Someone else changed this note. Your draft is still here.', current }, 409);
    if (method === 'DELETE') { this.sql.exec('DELETE FROM notes WHERE id = ?', current.id); return json({ deleted: true }); }
    if (!noteValid(body)) return error('Use a title of 1–160 characters and a note smaller than 100 KB.');
    if (!this.fits(body.body, current.id)) return error('This notebook has reached its 1 MB limit.', 413);
    this.sql.exec('UPDATE notes SET title = ?, body = ?, version = version + 1, updatedAt = ? WHERE id = ?', body.title.trim(), body.body, Date.now(), current.id);
    return json(this.sql.exec('SELECT * FROM notes WHERE id = ?', current.id).one());
  }
  fits(body, excluded = '') {
    const { bytes } = this.sql.exec("SELECT COALESCE(SUM(length(CAST(body AS BLOB))), 0) AS bytes FROM notes WHERE id != ?", excluded).one();
    return bytes + new TextEncoder().encode(body).length <= MAX_TOTAL;
  }
}

async function payload(request) {
  if (!request.headers.get('content-type')?.startsWith('application/json')) throw new Error('Send JSON.');
  // Bound actual streamed bytes, including requests without Content-Length.
  const reader = request.body?.getReader();
  if (!reader) throw new Error('Missing request body.');
  const chunks = []; let size = 0;
  while (true) {
    const { value, done } = await reader.read(); if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY) { await reader.cancel(); throw new Error('Request is too large.'); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder().decode(bytes));
}

async function route(request, env) {
  const url = new URL(request.url), path = url.pathname;
  if (path === '/health') return json({ service: 'nexa-notes', preview: env.PREVIEW_MODE === 'true' });
  if (!path.startsWith('/api/')) return env.ASSETS.fetch(request);
  if (!['GET', 'POST', 'PUT', 'DELETE'].includes(request.method)) return error('Method not allowed.', 405);
  const origin = request.headers.get('origin');
  if (origin && origin !== url.origin) return error('Use this notebook’s own website.', 403);
  if (request.headers.get('sec-fetch-site') === 'cross-site') return error('Cross-site requests are not allowed.', 403);
  let body;
  if (['POST', 'PUT'].includes(request.method) || (request.method === 'DELETE' && /\/notes\//.test(path))) {
    try { body = await payload(request); } catch { return error('Send valid JSON smaller than 110 KB.'); }
  }
  if (path === '/api/notebooks' && request.method === 'POST') {
    const { success } = await env.CREATION_LIMIT.limit({ key: `${url.hostname}:${request.headers.get('cf-connecting-ip') || 'local'}` });
    if (!success) return error('Too many notebooks created. Try again in a minute.', 429);
    const notes = body?.notes ?? [];
    if (!Array.isArray(notes) || notes.length > MAX_NOTES || !notes.every(noteValid)) return error('Invalid starter notes.');
    const id = crypto.randomUUID().replaceAll('-', ''), secret = token();
    const response = await env.NOTEBOOKS.getByName(id).init(await digest(secret), notes);
    return json({ ...await response.json(), id, token: secret }, response.status);
  }
  const match = /^\/api\/notebooks\/([a-f0-9]{32})(.*)$/.exec(path);
  const secret = /^Bearer ([a-f0-9]{64})$/.exec(request.headers.get('authorization') || '')?.[1];
  if (!match) return error('Not found.', 404);
  if (!secret) return error('Open a valid notebook link.', 401);
  return env.NOTEBOOKS.getByName(match[1]).handle(request.method, match[2], secret, body);
}

export default {
  async fetch(request, env) {
    if (env.PREVIEW_MODE !== 'true' && true) { try { await accessUser(request, env); } catch (error) { return accessFailure(error); } }
    let response;
    try { response = await route(request, env); } catch { response = error('Unable to save right now. Your draft stays in this browser.', 503); }
    if (env.PREVIEW_MODE === 'true' && response.headers.get('content-type')?.includes('text/html')) response = new HTMLRewriter().on('#template-preview', { element(element) { element.removeAttribute('hidden'); } }).transform(response);
    response = new Response(response.body, response);
    if (env.PREVIEW_MODE === 'true') response.headers.set('x-robots-tag', 'noindex, nofollow');
    response.headers.set('cache-control', 'no-store');
    response.headers.set('referrer-policy', 'no-referrer');
    response.headers.set('x-content-type-options', 'nosniff');
    response.headers.set('content-security-policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    response.headers.set('permissions-policy', 'camera=(), microphone=(), geolocation=()');
    return response;
  },
};
