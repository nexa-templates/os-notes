import { mountSelect } from './select-mount.tsx';
import { Editor, Node, InputRule, Extension } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { Markdown } from '@tiptap/markdown';
import { TableKit } from '@tiptap/extension-table';
import TaskList from '@tiptap/extension-task-list';
import TaskItem from '@tiptap/extension-task-item';
import Highlight from '@tiptap/extension-highlight';
import CodeBlockLowlight from '@tiptap/extension-code-block-lowlight';
import { createLowlight, common } from 'lowlight';
import { marked } from 'marked';
import DOMPurify from 'dompurify';

const lowlight = createLowlight(common);
const tags = ['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'a', 'strong', 'b', 'em', 'i', 's', 'del', 'mark', 'ul', 'ol', 'li', 'code', 'pre', 'blockquote', 'hr', 'br', 'table', 'thead', 'tbody', 'tr', 'th', 'td'];
export const sanitize = html => DOMPurify.sanitize(html, { ALLOWED_TAGS: tags, ALLOWED_ATTR: ['href', 'title', 'start'] });
export const safeURL = value => /^(https?:\/\/|mailto:)/i.test(value) && !/[\s\u0000-\u001f]/.test(value);

// Keep unsupported source intact. Opening, reading, or changing a title must
// never silently discard HTML, embeds, frontmatter, or plugin-specific syntax.
export function sourceOnly(body) {
  let unsupported = /^(---\r?\n[\s\S]*?\r?\n---|\$\$|\[\^[^\]]+\]:)|!\[\[|%%|\$[^\s$][^\n$]*\$|^>\s*\[!/m.test(body);
  marked.walkTokens(marked.lexer(body), token => { if (['html', 'image'].includes(token.type)) unsupported = true; });
  return unsupported;
}

const WikiLink = Node.create({
  name: 'wikiLink', group: 'inline', inline: true, atom: true,
  addAttributes() { return { target: { default: '' }, label: { default: '' } }; },
  parseHTML() { return [{ tag: 'span[data-wiki]', getAttrs: element => ({ target: element.dataset.wiki, label: element.textContent }) }]; },
  renderHTML({ node }) { return ['span', { class: 'wiki', 'data-wiki': node.attrs.target, role: 'link', tabindex: '0', title: `Open ${node.attrs.target}` }, node.attrs.label || node.attrs.target]; },
  renderText({ node }) { return `[[${node.attrs.target}${node.attrs.label ? `|${node.attrs.label}` : ''}]]`; },
  markdownTokenizer: {
    name: 'wikiLink', level: 'inline', start: src => src.indexOf('[['),
    tokenize(src) { const match = /^\[\[([^\]\n|]{1,160})(?:\|([^\]\n]+))?\]\]/.exec(src); if (match) return { type: 'wikiLink', raw: match[0], target: match[1], label: match[2] || '' }; },
  },
  parseMarkdown(token) { return { type: 'wikiLink', attrs: { target: token.target, label: token.label } }; },
  renderMarkdown(node) { return `[[${node.attrs.target}${node.attrs.label ? `|${node.attrs.label}` : ''}]]`; },
  addInputRules() {
    return [new InputRule({ find: /\[\[([^\]\n|]{1,160})(?:\|([^\]\n]+))?\]\]$/, handler: ({ state, range, match }) => { state.tr.replaceWith(range.from, range.to, this.type.create({ target: match[1], label: match[2] || '' })); } })];
  },
});

export function createRichEditor({ element, toolbar, onChange, onWiki, onLink, noteTitles }) {
  let editor, identity, lastBody, suspended = false, suggestion = null, suggestionIndex = 0;
  const $ = selector => toolbar.querySelector(selector);
  toolbar.innerHTML = `<div class="format-row" role="toolbar" aria-label="Text formatting">
    <div data-text-style></div>
    <div class="format-group" data-group="marks"></div><div class="format-group" data-group="blocks"></div><div class="format-group" data-group="history"></div>
  </div><div class="table-tools" role="toolbar" aria-label="Table editing" hidden></div>
  <div class="code-tools" hidden>Language <div data-code-language></div></div>`;
  const style = mountSelect($('[data-text-style]'), [{ value: 'paragraph', label: 'Text' }, ...[1, 2, 3, 4, 5, 6].map(n => ({ value: `h${n}`, label: `Heading ${n}` })), { value: 'blockquote', label: 'Quote' }, { value: 'codeBlock', label: 'Code block' }], 'Text style', 'paragraph', changeStyle);
  const language = mountSelect($('[data-code-language]'), [{ value: '', label: 'Plain text' }, ...['javascript', 'typescript', 'json', 'python', 'bash', 'html', 'css', 'sql'].map(value => ({ value, label: value }))], 'Code language', '', value => editor.chain().focus().updateAttributes('codeBlock', { language: value || null }).run());
  const buttons = [];
  function button(group, label, text, action, active, enabled) {
    const button = document.createElement('button'); button.type = 'button'; button.textContent = text;
    button.title = label; button.setAttribute('aria-label', label);
    button.onmousedown = event => event.preventDefault();
    button.onclick = () => { if (editor?.isEditable) { action(editor.chain().focus()); sync(); } };
    group.append(button); buttons.push({ button, active, enabled }); return button;
  }
  const marks = $('[data-group=marks]'), blocks = $('[data-group=blocks]'), history = $('[data-group=history]');
  button(marks, 'Bold (Ctrl/⌘ B)', 'B', c => c.toggleBold().run(), 'bold').className = 'format-bold';
  button(marks, 'Italic (Ctrl/⌘ I)', 'I', c => c.toggleItalic().run(), 'italic').className = 'format-italic';
  button(marks, 'Strikethrough', 'S', c => c.toggleStrike().run(), 'strike').className = 'format-strike';
  button(marks, 'Highlight', 'H', c => c.toggleHighlight().run(), 'highlight').className = 'format-highlight';
  button(marks, 'Inline code', '</>', c => c.toggleCode().run(), 'code');
  button(marks, 'Insert or edit link (Ctrl/⌘ K)', 'Link', () => onLink(editor), 'link');
  button(marks, 'Link to a note', '[[ ]]', () => onLink(editor, true));
  button(blocks, 'Bullet list', '• List', c => c.toggleBulletList().run(), 'bulletList');
  button(blocks, 'Numbered list', '1. List', c => c.toggleOrderedList().run(), 'orderedList');
  button(blocks, 'Checklist', '☑', c => c.toggleTaskList().run(), 'taskList');
  button(blocks, 'Insert table', 'Table', c => c.insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run());
  button(blocks, 'Horizontal rule', '―', c => c.setHorizontalRule().run());
  button(history, 'Undo (Ctrl/⌘ Z)', '↶', c => c.undo().run(), null, () => editor.can().undo());
  button(history, 'Redo (Ctrl/⌘ Shift Z)', '↷', c => c.redo().run(), null, () => editor.can().redo());
  const table = $('.table-tools');
  for (const [label, command] of [['Add row', 'addRowAfter'], ['Add column', 'addColumnAfter'], ['Delete row', 'deleteRow'], ['Delete column', 'deleteColumn'], ['Delete table', 'deleteTable']]) button(table, label, label, c => c[command]().run());
  function changeStyle(value) {
    const chain = editor.chain().focus();
    if (/^h[1-6]$/.test(value)) chain.setHeading({ level: Number(value[1]) }).run();
    else if (value === 'blockquote') chain.toggleBlockquote().run();
    else if (value === 'codeBlock') chain.toggleCodeBlock().run();
    else chain.clearNodes().setParagraph().run();
    sync();
  };

  function sync() {
    if (!editor) return;
    for (const { button, active, enabled } of buttons) {
      button.disabled = !editor.isEditable || !!(enabled && !enabled());
      if (active) button.setAttribute('aria-pressed', String(editor.isActive(active)));
    }
    const heading = editor.getAttributes('heading').level;
    style.value = editor.isActive('codeBlock') ? 'codeBlock' : editor.isActive('heading') ? `h${heading}` : editor.isActive('blockquote') ? 'blockquote' : 'paragraph';
    table.hidden = !editor.isActive('table'); $('.code-tools').hidden = !editor.isActive('codeBlock');
    language.value = editor.getAttributes('codeBlock').language || '';
  }
  const suggestions = document.createElement('div'); suggestions.className = 'note-suggestions'; suggestions.hidden = true;
  suggestions.setAttribute('role', 'listbox'); suggestions.setAttribute('aria-label', 'Link to note'); suggestions.id = 'note-suggestions';
  element.after(suggestions);
  function closeSuggestions() { suggestion = null; suggestions.hidden = true; if (editor && !editor.isDestroyed) editor.view.dom.removeAttribute('aria-activedescendant'); }
  function chooseSuggestion(index) {
    if (!suggestion) return;
    const target = suggestion.titles[index];
    editor.chain().focus().insertContentAt({ from: suggestion.from, to: suggestion.to }, { type: 'wikiLink', attrs: { target } }).insertContent(' ').run();
    closeSuggestions();
  }
  function suggest() {
    if (!editor?.isEditable || !editor.isFocused || !editor.state.selection.empty || editor.isActive('codeBlock') || editor.isActive('code')) return closeSuggestions();
    const { $from } = editor.state.selection, match = /\[\[([^\]\n]{0,160})$/.exec($from.parent.textBetween(0, $from.parentOffset, '\n', '\ufffc'));
    if (!match) return closeSuggestions();
    const titles = noteTitles().filter(title => title.toLowerCase().includes(match[1].toLowerCase())).slice(0, 7);
    if (!titles.length) return closeSuggestions();
    const from = $from.pos - match[0].length;
    if (suggestion?.from !== from || suggestion?.query !== match[1]) suggestionIndex = 0;
    suggestion = { from, to: $from.pos, query: match[1], titles };
    suggestions.replaceChildren(...titles.map((title, index) => {
      const button = document.createElement('button'); button.type = 'button'; button.textContent = title;
      button.id = `note-suggestion-${index}`; button.setAttribute('role', 'option'); button.setAttribute('aria-selected', String(index === suggestionIndex));
      button.onmousedown = event => event.preventDefault(); button.onclick = () => chooseSuggestion(index); return button;
    }));
    suggestions.hidden = false;
    const cursor = editor.view.coordsAtPos($from.pos);
    suggestions.style.left = `${Math.max(12, Math.min(cursor.left, innerWidth - 292))}px`;
    suggestions.style.top = `${Math.max(12, Math.min(cursor.bottom + 6, innerHeight - 270))}px`;
    editor.view.dom.setAttribute('aria-activedescendant', `note-suggestion-${suggestionIndex}`);
  }
  const shortcuts = Extension.create({
    name: 'noteShortcuts',
    addKeyboardShortcuts() { return { 'Mod-k': () => { if (!this.editor.isEditable) return false; onLink(this.editor); return true; }, Tab: () => this.editor.isEditable && this.editor.commands.sinkListItem(this.editor.isActive('taskList') ? 'taskItem' : 'listItem'), 'Shift-Tab': () => this.editor.isEditable && this.editor.commands.liftListItem(this.editor.isActive('taskList') ? 'taskItem' : 'listItem') }; },
  });
  function mount(body, editable) {
    editor?.destroy(); element.replaceChildren(); closeSuggestions();
    editor = new Editor({
      element, editable, injectCSS: false,
      extensions: [StarterKit.configure({ codeBlock: false, underline: false, link: { openOnClick: false, defaultProtocol: 'https', isAllowedUri: safeURL } }), Markdown.configure({ markedOptions: { gfm: true } }), TableKit.configure({ table: { resizable: false } }), TaskList, TaskItem.configure({ nested: true }), Highlight, CodeBlockLowlight.configure({ lowlight }), WikiLink, shortcuts],
      content: body, contentType: 'markdown',
      editorProps: {
        attributes: { class: 'markdown prose-editor', role: 'textbox', 'aria-label': 'Note content', 'aria-multiline': 'true', spellcheck: 'true', 'data-placeholder': 'Write a thought… Type [[ to connect a note.' },
        transformPastedHTML: sanitize,
        handlePaste(view, event) {
          const text = event.clipboardData?.getData('text/plain');
          if (!event.clipboardData?.getData('text/html') && text && !sourceOnly(text) && /(^#{1,6} |\n|\*\*|\[\[|^- )/m.test(text)) {
            event.preventDefault(); editor.commands.insertContent(text, { contentType: 'markdown' }); return true;
          }
          return false;
        },
        handleKeyDown(view, event) {
          if (suggestion && ['ArrowDown', 'ArrowUp', 'Enter', 'Tab', 'Escape'].includes(event.key)) {
            event.preventDefault();
            if (event.key === 'Escape') closeSuggestions();
            else if (['Enter', 'Tab'].includes(event.key)) chooseSuggestion(suggestionIndex);
            else { suggestionIndex = (suggestionIndex + (event.key === 'ArrowDown' ? 1 : -1) + suggestion.titles.length) % suggestion.titles.length; suggest(); }
            return true;
          }
          const wiki = event.target.closest('[data-wiki]');
          if (wiki && event.key === 'Enter') { onWiki(wiki.dataset.wiki); return true; }
          return false;
        },
        handleClick(view, pos, event) {
          const wiki = event.target.closest('[data-wiki]');
          if (wiki) { event.preventDefault(); onWiki(wiki.dataset.wiki); return true; }
          const anchor = event.target.closest('a');
          if (anchor && safeURL(anchor.getAttribute('href') || '') && (!editor.isEditable || event.ctrlKey || event.metaKey)) { window.open(anchor.href, '_blank', 'noopener,noreferrer'); return true; }
          return false;
        },
      },
      onUpdate() { if (!suspended) { lastBody = editor.getMarkdown(); onChange(lastBody); } sync(); suggest(); },
      onSelectionUpdate() { sync(); suggest(); },
      onBlur() { setTimeout(() => { if (!editor?.isFocused) closeSuggestions(); }, 0); },
    });
    sync();
  }
  return {
    show(body, editable, key) {
      if (!editor || identity !== key || lastBody !== body) { suspended = true; mount(body, editable); suspended = false; identity = key; lastBody = body; }
      else editor.setEditable(editable, false);
      editor.view.dom.setAttribute('aria-readonly', String(!editable));
      for (const checkbox of element.querySelectorAll('input[type=checkbox]')) checkbox.disabled = !editable;
      sync();
    },
    hide() { closeSuggestions(); },
    focus() { editor?.commands.focus(); },
    get editor() { return editor; },
  };
}
