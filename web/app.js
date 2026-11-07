import { mountSelect } from './select-mount.tsx';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { createRichEditor, sourceOnly, safeURL } from './rich-editor.js';

const $ = selector => document.querySelector(selector);
const shareRole = mountSelect($('#share-role'), [{ value: 'view', label: 'Can view' }, { value: 'edit', label: 'Can edit' }], 'Access', 'view', () => { $('#link-result').hidden = true; $('#share-status').textContent = ''; });
const initial = [
  { title: 'Start here', body: 'A little space for the things worth keeping. Ideas, meeting notes, decisions, and everything your team learns along the way.\n\n## Less organizing. More thinking.\n\nKeep your notes in plain Markdown. Give each thought a home, then connect it to the next one. There’s no complicated setup to get in your way.\n\n- **Write naturally.** Headings, lists, links, and a little room to think.\n- **Connect your ideas.** Type `[[` and a note title to link your notes.\n- **Bring people in.** Share a view or edit link to your notebook.\n\n> A good notebook isn’t a perfect system. It’s a place you keep coming back to.\n\n## A few places to start\n\nCollect a spark in [[Project ideas]], take a breath with [[Weekly notes]], or put the things everyone should know in [[Team handbook]].\n\n---\n\nMake this space your own. Create a notebook, add your first note, and share it with someone.' },
  { title: 'Project ideas', body: 'A place for ideas before they become plans.\n\n## A better welcome\n\nWhat if every new teammate had one page with everything they needed for their first week? Start with the [[Team handbook]].\n\n## Small improvements\n\n- A shared list of customer questions\n- A Friday note with what we learned\n- A quieter, simpler way to keep everyone in the loop\n\n## Next up\n\nPick one idea during our [[Weekly notes]] check-in.' },
  { title: 'Weekly notes', body: '## This week\n\n### Focus\n\nMake room for the work that matters. Keep the list short.\n\n- [ ] Choose one idea from [[Project ideas]]\n- [ ] Update the [[Team handbook]]\n- [ ] Write down one thing we learned\n\n### Decisions\n\nKeep important decisions here so nobody has to search a chat history.\n\n### Notes\n\nWhat went well? What could be simpler next week?' },
  { title: 'Team handbook', body: 'A small, living guide to working together.\n\n## How we work\n\nWrite things down. Ask when something is unclear. Leave enough context for the next person.\n\n## Our notebook\n\n- [[Start here]] — a quick introduction\n- [[Weekly notes]] — what we’re working on\n- [[Useful links]] — the things we reach for often\n\n## Sharing\n\nThe owner can create **view** or **edit** links from Share. Everyone with an edit link can add and change notes. Only the owner can change sharing or delete the notebook.' },
  { title: 'Useful links', body: '## Markdown essentials\n\nUse `# Heading`, `**bold**`, `- a list item`, or `[a link](https://example.com)`.\n\nConnect notes with `[[Note title]]`. Notes that link here will appear under **Linked from**.\n\n## Take your notes with you\n\nUse **Export** to download the current note as a Markdown file. Use **Import Markdown** to bring existing `.md` files into your notebook.\n\nBack to [[Start here]].' },
];
const example = { name: 'Example notebook', role: 'example', notes: initial.map((note, i) => ({ ...note, id: `example-${i}`, version: 1, updatedAt: 0 })) };
let notebook = structuredClone(example), credentials = null, selected = notebook.notes[0].id, draft = null;
let mode = 'write', dirty = false, conflict = false, timer, saving = null, refreshing = false;
let writes = 0, writeRevision = 0;
let savedNotebooks = readStorage('nexa-notes:notebooks', []);
if (!Array.isArray(savedNotebooks)) savedNotebooks = [];
function readStorage(key, fallback) { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } }
function store(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch { notice('Browser storage is unavailable. Keep your notebook link and export any unsaved work.'); return false; } }
function removeStorage(key) { try { localStorage.removeItem(key); } catch {} }
function notice(message = '') { $('#notice').textContent = message; $('#notice').hidden = !message; }
function status(message) { $('#status').textContent = message; }
const writable = () => ['owner', 'edit'].includes(notebook.role);
const current = () => notebook.notes.find(note => note.id === selected);
const draftKey = () => credentials && `nexa-notes:draft:${credentials.id}:${credentials.token}:${selected}`;
const selectionKey = () => credentials && `nexa-notes:selected:${credentials.id}:${credentials.token}`;
const link = value => `${location.origin}/#${new URLSearchParams({ notebook: value.id, key: value.token })}`;
async function api(path = '', method = 'GET', body, auth = credentials) {
  const writing = method !== 'GET';
  if (writing) { writes++; writeRevision++; }
  try {
    const response = await fetch(auth ? `/api/notebooks/${auth.id}${path}` : '/api/notebooks', {
      method, headers: { ...(auth ? { authorization: `Bearer ${auth.token}` } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15000),
    });
    const data = await response.json();
    if (!response.ok) throw Object.assign(new Error(data.error || 'Unable to reach the notebook.'), { status: response.status, data });
    return data;
  } finally { if (writing) writes--; }
}
function remember() {
  if (!credentials) return;
  savedNotebooks = savedNotebooks.filter(item => !(item.id === credentials.id && item.token === credentials.token));
  savedNotebooks.unshift({ ...credentials, role: notebook.role, name: notebook.name });
  store('nexa-notes:notebooks', savedNotebooks.slice(0, 20));
}
function renderNotebooks() {
  $('#notebooks>span').textContent = `${notebook.name}${credentials ? ` · ${notebook.role}` : ''}`;
  const menu = $('#notebook-menu'); menu.replaceChildren();
  for (const item of [null, ...savedNotebooks]) {
    const button = document.createElement('button'); button.type = 'button'; button.setAttribute('role', 'menuitemradio');
    button.textContent = item ? `${item.name} · ${item.role}` : 'Example notebook';
    button.setAttribute('aria-checked', String(item ? item.id === credentials?.id && item.token === credentials?.token : !credentials));
    button.onclick = () => run(async () => {
      closeNotebooks(); if (!await flush()) return;
      if (!item) return activate(structuredClone(example), null);
      await activate(await api('', 'GET', undefined, item), { id: item.id, token: item.token });
    });
    menu.append(button);
  }
  $('#notebook-name').textContent = notebook.name;
}
function closeNotebooks(focus = true) { $('#notebook-menu').hidden = true; $('#notebooks').setAttribute('aria-expanded', 'false'); if (focus) $('#notebooks').focus(); }
async function openWiki(target) {
  const title = target.trim(), note = notebook.notes.find(note => note.title.toLowerCase() === title.toLowerCase());
  if (note) return selectNote(note.id);
  if (writable()) return addNote(title);
  notice('That note has not been created yet.');
}
let linkEditor, linkSelection, linkingNote = false;
function editLink(editor, wiki = false) {
  linkEditor = editor; linkingNote = wiki;
  if (!wiki && editor.isActive('link')) editor.commands.extendMarkRange('link');
  const { from, to } = editor.state.selection; linkSelection = { from, to };
  $('#link-heading').textContent = wiki ? 'Link to a note' : 'Insert link';
  $('#link-target-label').firstChild.textContent = wiki ? 'Note title' : 'URL';
  $('#link-target').value = wiki ? '' : editor.getAttributes('link').href || '';
  $('#link-target').placeholder = wiki ? 'Start here' : 'https://example.com';
  $('#link-target').setAttribute('list', wiki ? 'note-titles' : '');
  $('#note-titles').replaceChildren(...notebook.notes.map(note => new Option(note.title, note.title)));
  $('#link-text').value = editor.state.doc.textBetween(from, to, ' ');
  $('#remove-link').hidden = wiki || !editor.isActive('link'); $('#link-error').textContent = '';
  $('#link-dialog').showModal(); $('#link-target').focus();
}
const rich = createRichEditor({ element: $('#rich-editor'), toolbar: $('#format-toolbar'), onChange: body => edited(body), onWiki: target => run(() => openWiki(target)), onLink: editLink, noteTitles: () => notebook.notes.map(note => note.title) });
function renderList() {
  const query = $('#search').value.trim().toLowerCase(), list = $('#note-list'); list.replaceChildren();
  const notes = notebook.notes.filter(note => `${note.title}\n${note.body}`.toLowerCase().includes(query));
  $('#note-count').textContent = notebook.notes.length;
  for (const note of notes) {
    const button = document.createElement('button'), text = document.createElement('span');
    text.textContent = note.id === selected && dirty ? draft.title || 'Untitled' : note.title;
    button.setAttribute('aria-label', text.textContent);
    button.append(text); button.setAttribute('aria-current', String(note.id === selected));
    button.onclick = () => run(() => selectNote(note.id)); list.append(button);
  }
  if (!notes.length) { const p = document.createElement('p'); p.className = 'empty-list'; p.textContent = query ? 'No matching notes.' : 'Your first note starts here.'; list.append(p); }
}
function renderMarkdown(body) {
  // Raw HTML is sanitized; images are omitted to avoid tracking other readers.
  $('#preview').innerHTML = DOMPurify.sanitize(marked.parse(body, { breaks: false }), { ALLOWED_TAGS: ['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'a', 'strong', 'em', 'del', 'ul', 'ol', 'li', 'code', 'pre', 'blockquote', 'hr', 'br', 'table', 'thead', 'tbody', 'tr', 'th', 'td'], ALLOWED_ATTR: ['href', 'title', 'start'] });
  const walker = document.createTreeWalker($('#preview'), NodeFilter.SHOW_TEXT), nodes = [];
  while (walker.nextNode()) if (!walker.currentNode.parentElement.closest('code,pre,a,button')) nodes.push(walker.currentNode);
  for (const node of nodes) {
    if (!node.textContent.includes('[[')) continue;
    const fragment = document.createDocumentFragment(); let end = 0;
    for (const match of node.textContent.matchAll(/\[\[([^\]\n]{1,160})\]\]/g)) {
      fragment.append(document.createTextNode(node.textContent.slice(end, match.index)));
      const [target, label] = match[1].split('|');
      const button = document.createElement('button'); button.className = 'wiki'; button.textContent = label || target;
      button.onclick = () => run(() => openWiki(target));
      fragment.append(button); end = match.index + match[0].length;
    }
    fragment.append(document.createTextNode(node.textContent.slice(end))); node.replaceWith(fragment);
  }
  for (const anchor of $('#preview').querySelectorAll('a')) { anchor.target = '_blank'; anchor.rel = 'noopener noreferrer'; }
}
function renderContent() {
  const note = current(); $('#document').hidden = !note;
  if (!note) { $('#word-count').textContent = ''; rich.hide(); return; }
  const body = draft?.body ?? note.body, unsupported = sourceOnly(body);
  const view = mode === 'write' ? !writable() ? 'read' : unsupported ? 'source' : 'write' : mode;
  $('#title').value = draft?.title ?? note.title; $('#editor').value = body;
  $('#title').readOnly = view === 'read' || !writable(); $('#editor').readOnly = !writable();
  $('#editor').hidden = view !== 'source'; $('#preview').hidden = view !== 'read' || !unsupported;
  $('#rich-editor').hidden = view === 'source' || unsupported;
  $('#format-toolbar').hidden = view !== 'write'; $('#source-hint').hidden = !unsupported || view !== 'source';
  for (const name of ['write', 'source', 'read']) $(`#${name}-mode`).setAttribute('aria-pressed', String(name === view));
  $('#write-mode').hidden = !writable();
  $('#delete').hidden = !writable();
  $('#breadcrumb-title').textContent = draft?.title || note.title;
  if (!$('#rich-editor').hidden) rich.show(body, view === 'write', `${credentials?.id || 'example'}:${selected}`);
  else rich.hide();
  if (!$('#preview').hidden) renderMarkdown(body);
  const backlinks = notebook.notes.filter(other => other.id !== selected && [...other.body.matchAll(/\[\[([^\]\n|]+)(?:\|[^\]\n]+)?\]\]/g)].some(match => match[1].trim().toLowerCase() === note.title.toLowerCase()));
  $('#backlinks').hidden = !backlinks.length || view === 'source';
  $('#backlinks div').replaceChildren(...backlinks.map(note => { const button = document.createElement('button'); button.textContent = note.title; button.onclick = () => run(() => selectNote(note.id)); return button; }));
  countWords(); document.title = `${note.title} · Notes`;
}
function countWords() { const words = (draft?.body || '').trim().split(/\s+/).filter(Boolean).length; $('#word-count').textContent = `${words} words`; }
function render() {
  renderNotebooks(); renderList(); renderContent();
  $('#new-note').disabled = !writable(); $('#import').disabled = !writable();
  $('#start').hidden = !!credentials; $('#share').hidden = notebook.role !== 'owner';
  $('#access').textContent = notebook.role === 'example' ? 'Explore the example, then make a notebook of your own.' : notebook.role === 'view' ? 'View only · Updates sync automatically' : 'Markdown · Changes sync automatically';
  $('#conflict').hidden = !conflict;
}
function loadDraft() {
  if (credentials && selected) store(selectionKey(), selected);
  const note = current(); draft = note ? { title: note.title, body: note.body, version: note.version } : null;
  dirty = false; conflict = false;
  const local = writable() && draftKey() && readStorage(draftKey(), null);
  if (note && local && typeof local.title === 'string' && typeof local.body === 'string' && Number.isInteger(local.version)) {
    draft = local; dirty = true;
    conflict = local.version !== note.version;
    if (conflict) $('#conflict>span').textContent = note.version === 0 ? 'This note was deleted. Your draft is still here.' : 'Someone else changed this note. Your draft is still here.';
    if (!conflict) timer = setTimeout(() => run(save), 650);
  }
  status(dirty ? 'Draft on this device' : credentials ? 'Saved' : 'Example');
}
async function selectNote(id) {
  if (!await flush()) return;
  selected = id; loadDraft(); render();
  $('.sidebar').classList.remove('open'); $('.document-scroll').scrollTop = 0;
}
function edited(body = draft?.body || '') {
  if (!writable()) return;
  draft = { ...draft, title: $('#title').value, body }; dirty = true;
  $('#editor').value = body; $('#breadcrumb-title').textContent = draft.title || 'Untitled';
  store(draftKey(), draft); status('Unsaved'); countWords(); renderList();
  clearTimeout(timer); if (!conflict) timer = setTimeout(() => run(save), 650);
}
async function save() {
  if (saving) return saving;
  if (!dirty || conflict || !draft || !writable()) return;
  if (!draft.title.trim()) { status('Add a title to save'); return; }
  const sent = { ...draft }, key = draftKey(); status('Saving…');
  saving = (async () => {
    try {
      const saved = await api(`/notes/${selected}`, 'PUT', sent);
      notebook.notes = notebook.notes.map(note => note.id === selected ? saved : note);
      if (draft.title === sent.title && draft.body === sent.body) { dirty = false; draft = { title: saved.title, body: saved.body, version: saved.version }; removeStorage(key); }
      else { draft.version = saved.version; store(key, draft); }
      status(dirty ? 'Unsaved' : 'Saved'); notice(); renderList();
      if (dirty) timer = setTimeout(() => run(save), 650);
    } catch (error) {
      if ([409, 404].includes(error.status)) {
        conflict = true; $('#conflict').hidden = false;
        $('#conflict>span').textContent = error.message;
      }
      status('Draft on this device'); notice(error.message || 'Connection lost. Your draft is saved on this device.');
    } finally { saving = null; }
  })();
  return saving;
}
async function flush() {
  clearTimeout(timer); if (saving) await saving;
  if (dirty && !conflict) await save();
  if (dirty) { notice('Save your draft or resolve the conflict before switching notes. You can also export it.'); return false; }
  return true;
}
async function activate(data, auth) {
  clearTimeout(timer); notebook = data; credentials = auth; selected = notebook.notes[0]?.id; mode = 'write';
  if (credentials) {
    const previous = readStorage(selectionKey(), null);
    if (typeof previous === 'string') {
      const local = writable() && readStorage(`nexa-notes:draft:${credentials.id}:${credentials.token}:${previous}`, null);
      if (notebook.notes.some(note => note.id === previous)) selected = previous;
      else if (local && typeof local.title === 'string' && typeof local.body === 'string' && Number.isInteger(local.version)) {
        notebook.notes.unshift({ id: previous, title: local.title, body: local.body, version: 0, updatedAt: 0 }); selected = previous;
      }
    }
  }
  history.replaceState(null, '', auth ? link(auth) : location.pathname);
  notice(); remember(); loadDraft(); render();
}
async function createNotebook() {
  if (!await flush()) return;
  const data = await api('', 'POST', { notes: initial }, null);
  await activate(data, { id: data.id, token: data.token });
  notice('Your notebook is ready. Use Share to invite someone or keep your owner link.');
}
async function addNote(title = 'Untitled', body = '') {
  if (!writable() || !await flush()) return;
  const note = await api('/notes', 'POST', { title, body });
  notebook.notes.unshift(note); selected = note.id; mode = 'write'; loadDraft(); render();
  $('.sidebar').classList.remove('open'); $('#title').focus(); $('#title').select();
}
async function refresh() {
  if (!credentials || dirty || saving || refreshing || writes || document.hidden || $('dialog[open]')) return;
  refreshing = true; const auth = credentials, revision = writeRevision;
  try {
    const data = await api('', 'GET');
    if (auth !== credentials || dirty || saving || revision !== writeRevision) return;
    const previous = current(), next = data.notes.find(note => note.id === selected);
    notebook = data; if (!next) selected = data.notes[0]?.id;
    if (previous?.version !== next?.version || previous?.id !== next?.id) { loadDraft(); renderContent(); }
    renderList(); status('Saved');
  } catch (error) { status(error.status === 403 ? 'Access revoked' : 'Offline'); }
  finally { refreshing = false; }
}
async function confirmAction(title, message, action = 'Delete') {
  const dialog = $('#confirm-dialog'); $('#confirm-heading').textContent = title; $('#confirm-text').textContent = message;
  dialog.querySelector('[value="confirm"]').textContent = action;
  dialog.returnValue = 'cancel'; dialog.showModal();
  return new Promise(resolve => dialog.addEventListener('close', () => resolve(dialog.returnValue === 'confirm'), { once: true }));
}
async function run(action) { try { await action(); } catch (error) { notice(error.message || 'Unable to reach the server. Your draft stays here.'); } }
function download(name, body) {
  const url = URL.createObjectURL(new Blob([body], { type: 'text/markdown;charset=utf-8' }));
  const a = document.createElement('a'); a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
$('#title').oninput = () => edited(); $('#editor').oninput = () => edited($('#editor').value); $('#search').oninput = renderList;
$('#new-note').onclick = () => run(() => addNote());
for (const id of ['start', 'new-notebook']) $(`#${id}`).onclick = () => run(async () => { const button = $(`#${id}`); button.disabled = true; try { await createNotebook(); } finally { button.disabled = false; } });
for (const name of ['write', 'source', 'read']) $(`#${name}-mode`).onclick = () => { mode = name; renderContent(); };
$('#export').onclick = () => { if (draft) download(`${draft.title.replace(/[^\p{L}\p{N} _-]/gu, '').slice(0, 100) || 'note'}.md`, draft.body); };
$('#delete').onclick = () => run(async () => {
  if (!current() || !await flush() || !await confirmAction('Delete note?', `“${current().title}” will be deleted for everyone in this notebook.`)) return;
  await api(`/notes/${selected}`, 'DELETE', { version: current().version });
  notebook.notes = notebook.notes.filter(note => note.id !== selected); selected = notebook.notes[0]?.id; loadDraft(); render();
});
$('#notebooks').onclick = () => {
  const open = $('#notebook-menu').hidden; $('#notebook-menu').hidden = !open; $('#notebooks').setAttribute('aria-expanded', String(open));
  if (open) ($('#notebook-menu [aria-checked=true]') || $('#notebook-menu button')).focus();
};
$('#notebook-menu').onkeydown = event => {
  const items = [...$('#notebook-menu').querySelectorAll('button')], index = items.indexOf(document.activeElement);
  if (['ArrowDown', 'ArrowUp', 'Home', 'End', 'Escape'].includes(event.key)) {
    event.preventDefault();
    if (event.key === 'Escape') return closeNotebooks();
    items[event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length].focus();
  }
};
document.addEventListener('pointerdown', event => { if (!event.target.closest('.notebook-switcher')) closeNotebooks(false); });
document.addEventListener('focusin', event => { if (!event.target.closest('.notebook-switcher')) closeNotebooks(false); });
$('#link-form').onsubmit = event => {
  event.preventDefault(); const target = $('#link-target').value.trim(), label = $('#link-text').value.trim();
  if (linkEditor !== rich.editor || linkEditor.isDestroyed || !linkEditor.isEditable) return $('#link-dialog').close();
  if (linkingNote ? !target || target.length > 160 || /[\[\]|\n]/.test(target + label) : !safeURL(target)) { $('#link-error').textContent = linkingNote ? 'Use a note title without brackets or line breaks.' : 'Enter an https://, http://, or mailto: link.'; return; }
  const selectedText = linkEditor.state.doc.textBetween(linkSelection.from, linkSelection.to, ' ');
  if (!linkingNote && selectedText && label === selectedText) {
    $('#link-dialog').close(); linkEditor.chain().focus().setTextSelection(linkSelection).setLink({ href: target }).run(); return;
  }
  const content = linkingNote ? { type: 'wikiLink', attrs: { target, label: label === target ? '' : label } } : { type: 'text', text: label || target, marks: [{ type: 'link', attrs: { href: target } }] };
  $('#link-dialog').close(); linkEditor.chain().focus().insertContentAt(linkSelection, content).run();
};
$('#close-link').onclick = () => { $('#link-dialog').close(); rich.focus(); };
$('#remove-link').onclick = () => { $('#link-dialog').close(); linkEditor.chain().focus().setTextSelection(linkSelection).unsetLink().run(); };
$('#save-copy').onclick = () => run(async () => {
  const note = await api('/notes', 'POST', { title: `${draft.title || 'Untitled'} (my draft)`.slice(0, 160), body: draft.body });
  removeStorage(draftKey()); notebook.notes.unshift(note); selected = note.id; loadDraft(); notice(); render();
});
$('#use-latest').onclick = () => run(async () => {
  if (!await confirmAction('Discard your draft?', 'Your local draft will be replaced by the server version. Export it first if you want to keep a copy.', 'Use latest')) return;
  const data = await api(); removeStorage(draftKey()); notebook = data;
  if (!current()) selected = notebook.notes[0]?.id;
  loadDraft(); notice(); render();
});
$('#import').onclick = () => $('#import-file').click();
$('#import-file').onchange = () => run(async () => {
  if (!await flush()) return;
  for (const file of $('#import-file').files) {
    if (file.size > 100_000) throw new Error(`${file.name} exceeds the 100 KB note limit.`);
    const note = await api('/notes', 'POST', { title: file.name.replace(/\.(md|markdown|txt)$/i, '').slice(0, 160) || 'Imported note', body: await file.text() });
    notebook.notes.unshift(note); selected = note.id; loadDraft(); render();
  }
  $('#import-file').value = ''; notice('Markdown imported.');
});
$('#share').onclick = () => { $('#share-status').textContent = ''; $('#link-result').hidden = true; $('#owner-link').value = link(credentials); $('#share-dialog').showModal(); };
$('#generate-link').onclick = async () => {
  $('#generate-link').disabled = true;
  try { const data = await api('/sharing', 'POST', { role: shareRole.value }); $('#share-link').value = link({ id: credentials.id, token: data.token }); $('#link-result').hidden = false; $('#share-status').textContent = `New ${data.role === 'edit' ? 'edit' : 'view'} link ready.`; }
  catch (error) { $('#share-status').textContent = error.message; }
  finally { $('#generate-link').disabled = false; }
};

$('#copy-link').onclick = async () => {
  try { await navigator.clipboard.writeText($('#share-link').value); $('#share-status').textContent = 'Link copied.'; }
  catch { $('#share-link').select(); $('#share-status').textContent = 'Select and copy the link above.'; }
};
$('#revoke').onclick = async () => {
  try { await api('/sharing', 'DELETE'); $('#link-result').hidden = true; $('#share-status').textContent = 'All view and edit links have been revoked. Your owner link still works.'; }
  catch (error) { $('#share-status').textContent = error.message; }
};
$('#delete-notebook').onclick = () => run(async () => {
  $('#share-dialog').close();
  if (!await confirmAction('Delete notebook?', 'All notes and sharing links will be permanently deleted. Export the notes you need first.')) return;
  if (!await flush()) return;
  await api('', 'DELETE'); removeStorage(draftKey());
  savedNotebooks = savedNotebooks.filter(item => item.id !== credentials.id); store('nexa-notes:notebooks', savedNotebooks);
  await activate(structuredClone(example), null);
});
$('#open-sidebar').onclick = () => $('.sidebar').classList.add('open');
$('#close-sidebar').onclick = () => $('.sidebar').classList.remove('open');
document.addEventListener('keydown', event => {
  if (event.key === 'Escape') $('.sidebar').classList.remove('open');
  if (!(event.ctrlKey || event.metaKey) || $('dialog[open]')) return;
  if (event.key.toLowerCase() === 'k' && !event.defaultPrevented) { event.preventDefault(); $('.sidebar').classList.add('open'); $('#search').focus(); }
  if (event.key.toLowerCase() === 'm' && event.shiftKey) { event.preventDefault(); mode = mode === 'source' ? 'write' : 'source'; renderContent(); }
  if (event.key.toLowerCase() === 's') { event.preventDefault(); run(save); }
});
const theme = readStorage('nexa-notes:theme', 'dark'); document.documentElement.dataset.theme = theme === 'light' ? 'light' : 'dark';
$('#theme').onclick = () => { const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'; document.documentElement.dataset.theme = next; store('nexa-notes:theme', next); };
addEventListener('beforeunload', event => { if (dirty || saving) { event.preventDefault(); event.returnValue = ''; } });
addEventListener('online', () => run(async () => { if (dirty) await save(); else await refresh(); }));
addEventListener('visibilitychange', () => { if (!document.hidden) run(refresh); });
setInterval(() => run(refresh), 2500);
async function openLocation() {
  if (!await flush()) { history.replaceState(null, '', credentials ? link(credentials) : location.pathname); return; }
  const params = new URLSearchParams(location.hash.slice(1)), id = params.get('notebook'), secret = params.get('key');
  if (!id && !secret) { await activate(structuredClone(example), null); return; }
  if (!/^[a-f0-9]{32}$/.test(id || '') || !/^[a-f0-9]{64}$/.test(secret || '')) { notice('This notebook link is incomplete. Ask the owner for a new link.'); return; }
  try { const auth = { id, token: secret }; await activate(await api('', 'GET', undefined, auth), auth); }
  catch (error) { notice(error.message); }
}
addEventListener('hashchange', () => run(openLocation));
loadDraft(); render(); run(openLocation);
