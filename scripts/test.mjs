import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright-core';

const directory = await mkdtemp(join(tmpdir(), 'nexa-notes-'));
const origin = process.env.NOTES_TEST_ORIGIN || 'http://127.0.0.1:8897';
let server, browser, debugPage;
const owners = [];
async function request(auth, path = '', method = 'GET', body, extra = {}) {
  const response = await fetch(`${origin}/api/notebooks${auth ? `/${auth.id}${path}` : ''}`, { method, headers: { ...(auth ? { authorization: `Bearer ${auth.token}` } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...extra }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, data: await response.json() };
}
const url = auth => `${origin}/#${new URLSearchParams({ notebook: auth.id, key: auth.token })}`;
try {
  if (!process.env.NOTES_TEST_ORIGIN) {
    server = spawn(process.execPath, ['node_modules/wrangler/bin/wrangler.js', 'dev', '--var', 'PREVIEW_MODE:true', '--ip', '127.0.0.1', '--port', '8897', '--persist-to', directory], { env: { ...process.env, CI: 'true', WRANGLER_SEND_METRICS: 'false' }, stdio: ['ignore', 'pipe', 'pipe'] });
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Local Worker did not start.')), 45000);
      const receive = chunk => { if (String(chunk).includes('Ready on')) { clearTimeout(timeout); resolve(); } };
      server.stdout.on('data', receive); server.stderr.on('data', receive);
      server.once('exit', code => { clearTimeout(timeout); reject(new Error(`Worker exited ${code}`)); });
    });
  }
  const created = await request(null, '', 'POST', { notes: [{ title: 'Test note', body: 'Original' }] });
  assert.equal(created.status, 201); const owner = { id: created.data.id, token: created.data.token }; owners.push(owner);
  const note = created.data.notes[0];
  const sharing = await request(owner, '/sharing', 'POST', { role: 'view' }); assert.equal(sharing.status, 200);
  const viewer = { id: owner.id, token: sharing.data.token };
  const editor = { id: owner.id, token: (await request(owner, '/sharing', 'POST', { role: 'edit' })).data.token };
  assert.equal((await request(viewer)).data.role, 'view');
  assert.equal((await request(viewer, '/notes', 'POST', { title: 'Forbidden', body: '' })).status, 403);
  assert.equal((await request(viewer, `/notes/${note.id}`, 'PUT', { ...note, body: 'Forbidden' })).status, 403);
  assert.equal((await request(viewer, `/notes/${note.id}`, 'DELETE', { version: note.version })).status, 403);
  assert.equal((await request(editor, '/sharing', 'POST', { role: 'view' })).status, 403);
  assert.equal((await request(editor, '', 'DELETE')).status, 403);
  assert.equal((await request({ id: owner.id, token: '0'.repeat(64) })).status, 403);
  const noAuth = await fetch(`${origin}/api/notebooks/${owner.id}`); assert.equal(noAuth.status, 401);
  assert.equal((await request(owner, '/notes', 'POST', { title: 'Cross origin', body: '' }, { origin: 'https://untrusted.example' })).status, 403);
  const race = await Promise.all(['First', 'Second'].map(body => request(editor, `/notes/${note.id}`, 'PUT', { ...note, body })));
  assert.deepEqual(race.map(result => result.status).sort(), [200, 409]);
  assert.equal((await request(owner, `/notes/${note.id}`, 'DELETE', { version: 1 })).status, 409);
  assert.equal((await request(owner, '/notes', 'POST', { title: 'Oversize', body: 'x'.repeat(100_001) })).status, 400);
  assert.equal((await request(owner, '/notes', 'POST', { title: 'Too large request', body: 'x'.repeat(120_000) })).status, 400);
  const independent = await request(null, '', 'POST', { notes: [] }); const other = { id: independent.data.id, token: independent.data.token }; owners.push(other);
  assert.equal((await request({ id: other.id, token: owner.token })).status, 403);
  await request(owner, '/sharing', 'DELETE');
  assert.equal((await request(viewer)).status, 403); assert.equal((await request(editor)).status, 403); assert.equal((await request(owner)).status, 200);
  const newEditor = { id: owner.id, token: (await request(owner, '/sharing', 'POST', { role: 'edit' })).data.token };
  const temporary = await request(newEditor, '/notes', 'POST', { title: 'Disposable', body: 'Editor can create' }); assert.equal(temporary.status, 201);
  assert.equal((await request(newEditor, `/notes/${temporary.data.id}`, 'DELETE', { version: 1 })).status, 200);
  console.log('API: durable CRUD, isolated notebooks, view/edit/owner access, revocation, size limits, origin checks, and simultaneous edit conflicts passed.');

  await mkdir('artifacts', { recursive: true });
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH, headless: true, args: ['--no-sandbox', '--disable-gpu'] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage(), errors = []; page.on('pageerror', error => errors.push(error.message));
  debugPage = page;
  await page.goto(origin); await page.locator('.wiki').first().waitFor();
  await page.screenshot({ path: 'artifacts/notes-desktop.png' });
  for (const theme of ['dark', 'light']) {
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
    for (const width of [1440, 390, 320]) {
      await page.setViewportSize({ width, height: 1000 });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${theme} ${width}: no overflow`);
      await page.screenshot({ path: `artifacts/notes-${theme}-${width}.png`, fullPage: true });
    }
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole('button', { name: 'Create your notebook', exact: true }).click();
  await page.getByRole('button', { name: 'Share', exact: true }).waitFor();
  const authParams = new URLSearchParams(new URL(page.url()).hash.slice(1)); const uiOwner = { id: authParams.get('notebook'), token: authParams.get('key') }; owners.push(uiOwner);
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
  await page.screenshot({ path: 'artifacts/notes-editor-desktop.png' });

  // Write is the default: real formatted editing with Markdown as the saved format.
  const content = page.getByRole('textbox', { name: 'Note content', exact: true });
  async function newNote() {
    const before = await page.locator('#note-list button').count();
    await page.getByRole('button', { name: 'New note', exact: false }).click();
    await page.waitForFunction(before => document.querySelectorAll('#note-list button').length === before + 1 && document.querySelector('#title').value === 'Untitled', before);
  }
  assert.equal(await content.getAttribute('contenteditable'), 'true');
  await newNote();
  await page.getByLabel('Note title', { exact: true }).fill('Editor showcase');
  const sample = '## A shared plan\n\n**Bold**, *italic*, ~~finished~~, ==important==, and `code`.\n\n- First\n  - Nested\n\n1. Ordered\n2. Second\n\n- [ ] Ship the editor\n- [x] Keep Markdown\n\n> A useful quote\n\n```javascript\nconst answer = 42;\n```\n\n| Name | Status |\n| --- | --- |\n| Notes | Ready |\n\n[[Start here|Welcome]] and [Example](https://example.com).\n\n---\n\nLast paragraph.';
  await page.getByRole('button', { name: 'Markdown', exact: true }).click();
  await page.getByLabel('Note Markdown').fill(sample);
  await page.getByRole('button', { name: 'Write', exact: true }).click();
  await content.locator('h2').getByText('A shared plan', { exact: true }).waitFor();
  assert.equal(await content.locator('strong').textContent(), 'Bold');
  assert.equal(await content.locator('em').textContent(), 'italic');
  assert.equal(await content.locator('mark').textContent(), 'important');
  assert.equal(await content.locator('ul ul').count(), 1);
  assert.equal(await content.locator('ol li').count(), 2);
  assert.equal(await content.locator('input[type=checkbox]').count(), 2);
  assert.ok(await content.locator('li[data-checked]').first().evaluate(el => Math.abs(el.querySelector('input').getBoundingClientRect().top - el.querySelector('p').getBoundingClientRect().top) < 12), 'Task checkbox and text share a line');
  assert.equal(await content.locator('pre code').textContent(), 'const answer = 42;');
  assert.equal(await content.locator('table tr').count(), 2);
  assert.equal(await content.locator('[data-wiki]').textContent(), 'Welcome');
  await page.getByRole('button', { name: 'Read', exact: true }).click();
  assert.equal(await content.getAttribute('contenteditable'), 'false');
  assert.equal(await content.locator('input[type=checkbox]').first().isDisabled(), true);
  await page.getByRole('button', { name: 'Markdown', exact: true }).click();
  assert.equal(await page.getByLabel('Note Markdown').inputValue(), sample, 'Switching views must preserve exact source without an edit');
  await page.getByRole('button', { name: 'Write', exact: true }).click();
  await content.locator('input[type=checkbox]').first().check();
  await content.locator('td').first().click();
  await page.getByRole('button', { name: 'Add row', exact: true }).click();
  assert.equal(await content.locator('table tr').count(), 3);
  await page.getByRole('button', { name: 'Add column', exact: true }).click();
  assert.equal(await content.locator('table tr').first().locator('th').count(), 3);
  await page.getByRole('button', { name: 'Delete column', exact: true }).click();
  await page.getByRole('button', { name: 'Markdown', exact: true }).click();
  const serialized = await page.getByLabel('Note Markdown').inputValue();
  assert.match(serialized, /\[x\] Ship the editor/);
  for (const fragment of ['==important==', '[[Start here|Welcome]]', '```javascript', 'const answer = 42;', 'https://example.com', 'Nested', '> A useful quote']) assert.ok(serialized.includes(fragment), `Preserves ${fragment}`);
  await page.getByRole('button', { name: 'Write', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#status').textContent === 'Saved');
  for (const theme of ['dark', 'light']) {
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
    for (const width of [1440, 390, 320]) {
      await page.setViewportSize({ width, height: 1000 });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `Rich editor ${theme} ${width}: no overflow`);
      await page.screenshot({ path: `artifacts/editor-${theme}-${width}.png`, fullPage: true });
    }
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole('button', { name: 'Switch notebook', exact: true }).click();
  assert.equal(await page.getByRole('menu', { name: 'Notebooks', exact: true }).isVisible(), true);
  assert.equal(await page.getByRole('menuitemradio', { name: 'Team notebook · owner', exact: true }).getAttribute('aria-checked'), 'true');
  for (const theme of ['dark', 'light']) {
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
    await page.screenshot({ path: `artifacts/notebook-menu-${theme}.png` });
  }
  await page.keyboard.press('ArrowUp'); await page.keyboard.press('Escape');
  assert.equal(await page.getByRole('menu', { name: 'Notebooks', exact: true }).isHidden(), true);
  assert.equal(await page.getByRole('button', { name: 'Switch notebook', exact: true }).evaluate(el => el === document.activeElement), true);
  await page.reload(); await content.locator('h2').getByText('A shared plan', { exact: true }).waitFor();
  assert.equal(await content.locator('input[type=checkbox]').first().isChecked(), true);
  assert.equal(await content.locator('table tr').count(), 3);

  await newNote();
  await page.getByLabel('Note title', { exact: true }).fill('Formatting test');
  await content.fill('Bold from the toolbar'); await content.press('Control+a');
  await page.getByRole('button', { name: 'Bold (Ctrl/⌘ B)', exact: true }).click();
  assert.equal(await content.locator('strong').textContent(), 'Bold from the toolbar');
  await page.getByRole('button', { name: 'Undo (Ctrl/⌘ Z)', exact: true }).click(); assert.equal(await content.locator('strong').count(), 0);
  await page.getByRole('button', { name: 'Redo (Ctrl/⌘ Shift Z)', exact: true }).click(); assert.equal(await content.locator('strong').count(), 1);
  await content.press('Control+k'); await page.getByRole('heading', { name: 'Insert link', exact: true }).waitFor();
  await page.locator('#link-target').fill('javascript:alert(1)'); await page.getByRole('button', { name: 'Apply link', exact: true }).click();
  await page.getByText('Enter an https://, http://, or mailto: link.', { exact: true }).waitFor();
  await page.locator('#link-target').fill('https://example.com'); await page.getByRole('button', { name: 'Apply link', exact: true }).click();
  assert.equal(await content.locator('a').getAttribute('href'), 'https://example.com');
  assert.equal(await content.locator('a strong, strong a').textContent(), 'Bold from the toolbar', 'Adding a link preserves text formatting');
  assert.equal(await page.locator('select').count(), 0, 'All selectors use custom controls');
  await page.getByRole('combobox', { name: 'Text style', exact: true }).click();
  await page.getByRole('option', { name: 'Heading 2', exact: true }).click();
  assert.equal(await content.locator('h2').textContent(), 'Bold from the toolbar');
  await page.getByRole('combobox', { name: 'Text style', exact: true }).click();
  await page.getByRole('option', { name: 'Code block', exact: true }).click();
  await page.getByRole('combobox', { name: 'Code language', exact: true }).click();
  await page.getByRole('option', { name: 'python', exact: true }).click();
  assert.equal(await content.locator('pre code').getAttribute('class'), 'language-python');
  await page.getByRole('combobox', { name: 'Text style', exact: true }).click();
  await page.getByRole('option', { name: 'Text', exact: true }).click();
  assert.equal(await content.locator('pre,h2').count(), 0);
  
  await content.fill('');
  await content.evaluate(element => {
    const data = new DataTransfer(); data.setData('text/html', '<p><strong>Pasted safely</strong><img src=x onerror="window.pasteXSS=true"><script>window.pasteXSS=true</script><a href="javascript:alert(1)">Unsafe</a></p>');
    element.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  });
  assert.equal(await content.locator('strong').textContent(), 'Pasted safely');
  assert.equal(await content.locator('img,script,a[href^="javascript:"]').count(), 0);
  assert.equal(await page.evaluate(() => window.pasteXSS), undefined);
  await content.fill(''); await content.pressSequentially('## Typed heading');
  assert.equal(await content.locator('h2').textContent(), 'Typed heading');
  await content.press('Enter'); await content.pressSequentially('[[Sta');
  await page.getByRole('option', { name: 'Start here', exact: true }).waitFor(); await content.press('Enter');
  assert.equal(await content.locator('[data-wiki]').getAttribute('data-wiki'), 'Start here');
  await page.waitForFunction(() => document.querySelector('#status').textContent === 'Saved');
  await page.getByRole('button', { name: 'Markdown', exact: true }).click();
  assert.match(await page.getByLabel('Note Markdown').inputValue(), /## Typed heading/);
  assert.match(await page.getByLabel('Note Markdown').inputValue(), /\[\[Start here\]\]/);
  await page.getByRole('button', { name: 'Write', exact: true }).click();
  await page.locator('#note-list').getByRole('button', { name: 'Editor showcase', exact: true }).click();
  assert.equal(await page.getByRole('button', { name: 'Undo (Ctrl/⌘ Z)', exact: true }).isDisabled(), true, 'Undo history must not cross note boundaries');
  await page.getByRole('button', { name: 'Markdown', exact: true }).click();
  const protectedSource = '---\ntags: [team]\n---\n\nA note with ![image](https://example.com/tracker.png) and $x^2$.';
  await page.getByLabel('Note Markdown').fill(protectedSource);
  await page.getByRole('button', { name: 'Write', exact: true }).click();
  assert.equal(await page.getByLabel('Note Markdown').isVisible(), true, 'Unsupported constructs remain editable in source without losing data');
  assert.equal(await page.getByLabel('Note Markdown').inputValue(), protectedSource);
  await page.getByLabel('Note title', { exact: true }).fill('Protected source');
  await page.waitForFunction(() => document.querySelector('#status').textContent === 'Saved');
  assert.equal((await request(uiOwner)).data.notes.find(note => note.title === 'Protected source').body, protectedSource);

  await newNote();
  await page.getByLabel('Note title', { exact: true }).fill('Shared test');
  await page.getByRole('button', { name: 'Markdown', exact: true }).click();
  await page.getByLabel('Note Markdown').fill('Hello team. [[Start here]]\n\n<script>window.notesXSS = true</script><img src=x onerror="window.notesXSS=true"><a href="javascript:alert(1)">Unsafe</a><button id="share-link">Clobber</button>');
  await page.waitForFunction(() => document.querySelector('#status').textContent === 'Saved');
  await page.reload(); await page.getByRole('button', { name: 'Shared test', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Shared test', exact: true }).click();
  await page.getByRole('button', { name: 'Read', exact: true }).click();
  assert.equal(await page.evaluate(() => window.notesXSS), undefined);
  assert.equal(await page.locator('#preview script, #preview img, #preview a[href^="javascript:"], #preview [id]').count(), 0);
  assert.equal(await page.locator('#preview .wiki').count(), 1);
  await page.getByRole('button', { name: 'Share', exact: true }).click();
  await page.getByRole('button', { name: 'Create sharing link' }).click(); await page.locator('#link-result:not([hidden])').waitFor();
  const viewURL = await page.getByLabel('Sharing link', { exact: true }).inputValue();
  await page.getByRole('combobox', { name: 'Access', exact: true }).click();
  await page.getByRole('option', { name: 'Can edit', exact: true }).click();
  await page.getByRole('button', { name: 'Create sharing link' }).click(); await page.locator('#link-result:not([hidden])').waitFor();
  const editURL = await page.getByLabel('Sharing link', { exact: true }).inputValue();
  await page.keyboard.press('Escape'); assert.equal(await page.locator('dialog[open]').count(), 0);
  const secondContext = await browser.newContext(), second = await secondContext.newPage(); second.on('pageerror', error => errors.push(error.message));
  await second.goto(viewURL); await second.getByRole('button', { name: 'Shared test', exact: true }).waitFor();
  assert.equal(await second.getByRole('button', { name: 'Write', exact: true }).count(), 0);
  await second.getByRole('button', { name: 'Markdown', exact: true }).click();
  assert.equal(await second.getByLabel('Note Markdown').getAttribute('readonly'), '');
  assert.equal(await second.getByRole('button', { name: 'New note', exact: false }).isDisabled(), true);
  await second.goto(editURL); await second.getByRole('button', { name: 'Shared test', exact: true }).click();
  await second.getByRole('button', { name: 'Markdown', exact: true }).click();
  await second.getByLabel('Note Markdown').fill('Updated in another browser.');
  await second.waitForFunction(() => document.querySelector('#status').textContent === 'Saved');
  await page.getByText('Updated in another browser.', { exact: true }).waitFor();

  // An offline local edit must survive both a remote edit and a page reload.
  await page.getByRole('button', { name: 'Write', exact: true }).click(); await context.setOffline(true);
  await content.fill('My offline draft must survive.');
  await page.waitForFunction(() => document.querySelector('#status').textContent === 'Draft on this device');
  await second.getByLabel('Note Markdown').fill('The other editor wins this revision.');
  await second.waitForFunction(() => document.querySelector('#status').textContent === 'Saved');
  await context.setOffline(false); await page.locator('#conflict:not([hidden])').waitFor();
  await page.reload(); await page.locator('#conflict:not([hidden])').waitFor();
  assert.equal(await content.textContent(), 'My offline draft must survive.');
  await page.getByRole('button', { name: 'Save my draft as a new note' }).click();
  await page.getByRole('button', { name: 'Shared test (my draft)', exact: true }).waitFor();
  assert.equal(await page.locator('#conflict').isHidden(), true);
  await page.getByLabel('Search notes').fill('offline draft');
  assert.equal(await page.locator('#note-list button').count(), 1);
  await page.getByLabel('Search notes').fill('');
  await page.locator('#import-file').setInputFiles({ name: 'Imported.md', mimeType: 'text/markdown', buffer: Buffer.from('Imported content. [[Start here]]') });
  await page.getByRole('button', { name: 'Imported', exact: true }).waitFor();
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  const exported = await downloadPromise;
  assert.equal(exported.suggestedFilename(), 'Imported.md');
  assert.equal(await readFile(await exported.path(), 'utf8'), 'Imported content. [[Start here]]');
  await page.getByRole('button', { name: 'Write', exact: true }).click();
  await content.locator('.wiki').click();
  await page.getByRole('button', { name: 'Imported', exact: true }).nth(1).waitFor();
  assert.equal(await page.locator('#backlinks').isVisible(), true);
  // A remote deletion must also preserve the selected local draft across reload.
  await page.locator('#note-list').getByRole('button', { name: 'Imported', exact: true }).click();
  await page.getByRole('button', { name: 'Write', exact: true }).click();
  await context.setOffline(true);
  await content.fill('Draft from a remotely deleted note.');
  await page.waitForFunction(() => document.querySelector('#status').textContent === 'Draft on this device');
  const imported = (await request(uiOwner)).data.notes.find(note => note.title === 'Imported');
  assert.equal((await request(uiOwner, `/notes/${imported.id}`, 'DELETE', { version: imported.version })).status, 200);
  await context.setOffline(false); await page.locator('#conflict:not([hidden])').waitFor();
  await page.reload(); await page.locator('#conflict:not([hidden])').waitFor();
  assert.equal(await content.textContent(), 'Draft from a remotely deleted note.');
  await page.getByRole('button', { name: 'Save my draft as a new note' }).click();
  await page.getByRole('button', { name: 'Imported (my draft)', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Share', exact: true }).click();
  await page.getByRole('button', { name: 'Revoke all sharing links' }).click();
  await page.getByText('All view and edit links have been revoked.', { exact: false }).waitFor();
  await second.reload(); await second.getByText('This notebook link is invalid or has been revoked.', { exact: true }).waitFor();
  assert.deepEqual(errors, []);
  console.log('Browser: formatted editing, source round trips, task lists, tables, links, Markdown shortcuts, undo isolation, notebook picker, responsive themes, persistence, safe Markdown, sharing, offline conflict recovery, reload, and revocation passed.');
} catch (error) {
  if (debugPage && !debugPage.isClosed()) {
    console.error('Browser diagnostics:', await debugPage.evaluate(() => ({ status: document.querySelector('#status')?.textContent, notice: document.querySelector('#notice')?.textContent, notes: [...document.querySelectorAll('#note-list button')].map(el => el.textContent), title: document.querySelector('#title')?.value, hasNotebookLink: location.hash.includes('notebook='), dialogs: document.querySelectorAll('dialog[open]').length })));
    await debugPage.screenshot({ path: 'artifacts/test-failure.png' });
  }
  throw error;
} finally {
  for (const auth of owners) await request(auth, '', 'DELETE').catch(() => {});
  await browser?.close(); server?.kill('SIGTERM');
  if (server && server.exitCode === null) await new Promise(resolve => server.once('exit', resolve));
  await rm(directory, { recursive: true, force: true });
}
