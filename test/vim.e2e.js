// End-to-end tests for Vim Mode (vim.js). NEO runs on a throwaway library,
// keys are real key presses, and each check reads the chapter HTML that
// NEO saves. Run with `npm test`.

'use strict';

const { app, BrowserWindow, clipboard } = require('electron');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// A folder of its own for each run. Chromium writes to its profile until
// the process is gone, so a run can't remove its own; it removes those of
// earlier runs whose process has ended instead, leaving any still running.
for (const name of fs.readdirSync(os.tmpdir())) {
  const pid = /^neo-vim-test-(\d+)-/.exec(name);
  if (!pid || +pid[1] === process.pid) continue;
  try { process.kill(+pid[1], 0); continue; } catch (err) { if (err.code === 'EPERM') continue; }
  fs.rmSync(path.join(os.tmpdir(), name), { recursive: true, force: true });
}
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `neo-vim-test-${process.pid}-`));
app.setPath('userData', path.join(tmp, 'app'));
app.setPath('documents', tmp);
// run from test/, NEO's window would look for test/index.html
const loadFile = BrowserWindow.prototype.loadFile;
BrowserWindow.prototype.loadFile = function (file, opts) {
  return loadFile.call(this, path.resolve(__dirname, '..', file), opts);
};
require('../main.js');

let wc;
const js = (code) => wc.executeJavaScript(code, true);
const tick = (ms = 40) => new Promise((r) => setTimeout(r, ms));

// on a Mac the Edit menu owns ⌘Z and friends as native actions, which a
// sent key never reaches; they do what these web contents methods do
const MAC_MENU = { z: 'undo', x: 'cut', c: 'copy', v: 'paste', a: 'selectAll' };

// '3dd', 'ciwnew<Esc>', '<C-r>' (Ctrl), '<D-z>' (⌘ on a Mac, Ctrl elsewhere)
async function type(keys) {
  const cmd = process.platform === 'darwin' ? 'meta' : 'control';
  for (const k of keys.match(/<[^>]+>|./gs)) {
    const combo = /^<([CD])-(.)>$/.exec(k);
    if (combo && combo[1] === 'D' && process.platform === 'darwin' && MAC_MENU[combo[2]]) {
      await tick(80); // the keys before it land first
      wc[MAC_MENU[combo[2]]]();
      continue;
    }
    const named = combo ? combo[2] : { '<Esc>': 'Escape', '<Enter>': 'Enter', '<BS>': 'Backspace', '<Tab>': 'Tab' }[k];
    const modifiers = combo ? [combo[1] === 'C' ? 'control' : cmd] : /^[A-Z~!@#$%^&*()_+{}|:"<>?]$/.test(k) ? ['shift'] : [];
    const keyCode = named || k;
    wc.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
    if (!named || named === 'Enter') wc.sendInputEvent({ type: 'char', keyCode: named === 'Enter' ? '\r' : k, modifiers });
    wc.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
  }
  await tick(80); // the page gets sent keys asynchronously
}

// the book: two chapters, each set from HTML before every test
async function load(one, two = '<p>Chapter two starts here.</p>', vim = true) {
  await js(`(async () => {
    book.chapterOrder = [...vimTestChapters]; // a test may have split one off
    chapterHTML[book.chapterOrder[0]] = ${JSON.stringify(one)};
    chapterHTML[book.chapterOrder[1]] = ${JSON.stringify(two)};
    undoStack.length = 0;
    breakRun = 0;
    renderChapters();
    library.vim = ${vim};
    if (window.NeoVim) NeoVim.apply();
  })()`);
}
// the caret on paragraph n (counted across the book) at offset off
async function at(n, off = 0) {
  await js(`(() => {
    const p = document.querySelectorAll('.chapter-body > p')[${n}];
    p.closest('.chapter-body').focus();
    let r = rangeFromOffsets(p, ${off}, ${off});
    if (!r) { r = document.createRange(); r.setStart(p, 0); } // an empty paragraph
    getSelection().removeAllRanges();
    getSelection().addRange(r);
  })()`);
}
// each chapter's paragraphs as saved: 'class|inner HTML' or just the HTML
const chapters = () => js(`(book ? book.chapterOrder : []).map((id) => {
  const h = document.createElement('div');
  h.innerHTML = chapterHTML[id];
  return [...h.children].map((p) => (p.className ? p.className + '|' : '') + p.innerHTML);
})`);
const chapter = async (i = 0) => (await chapters())[i];
// where the caret is: [paragraph, offset]
const caret = () => js(`(() => {
  const p = focusParagraph();
  return p ? [[...document.querySelectorAll('.chapter-body > p')].indexOf(p), caretOffsetIn(p)] : null;
})()`);
const hint = () => js(`document.getElementById('hint').hidden ? '' : document.getElementById('hint').textContent`);

// what no edit may leave in a saved chapter
async function clean() {
  const bad = await js(`[...document.querySelectorAll('.chapter-body > p')].map((p) =>
    p.querySelector('span:not(.ph-mark)') ? 'a style span: ' + p.outerHTML
    : p.textContent && p.querySelector('br') ? 'a <br> beside text: ' + p.outerHTML
    : p.classList.contains('scene-break') && p.textContent !== '***' ? 'a stained scene break: ' + p.outerHTML
    : /[\\uD800-\\uDBFF](?![\\uDC00-\\uDFFF])|(?<![\\uD800-\\uDBFF])[\\uDC00-\\uDFFF]/.test(p.textContent) ? 'half an emoji: ' + escape(p.textContent)
    : '').filter(Boolean)`);
  assert.deepEqual(bad, []);
}

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

/* ---------- scene breaks are one unit ---------- */

test('x on a scene break removes the whole break, u brings it back', async () => {
  await load('<p>Before.</p><p class="scene-break">***</p><p>After.</p>');
  await at(1, 1);
  await type('x');
  assert.deepEqual(await chapter(), ['Before.', 'After.']);
  await type('u');
  assert.deepEqual(await chapter(), ['Before.', 'scene-break|***', 'After.']);
});

test('D and dw on a scene break remove the break', async () => {
  await load('<p>Before.</p><p class="scene-break">***</p><p>After.</p>');
  await at(1, 0);
  await type('D');
  assert.deepEqual(await chapter(), ['Before.', 'After.']);
  await load('<p>Before.</p><p class="scene-break">***</p><p>After.</p>');
  await at(1, 0);
  await type('dw');
  assert.deepEqual(await chapter(), ['Before.', 'After.']);
});

test('i and a on a scene break write on a new line beside it', async () => {
  await load('<p>Before.</p><p class="scene-break">***</p><p>After.</p>');
  await at(1, 1);
  await type('iabove<Esc>');
  assert.deepEqual(await chapter(), ['Before.', 'above', 'scene-break|***', 'After.']);
  await at(2, 1);
  await type('Abelow<Esc>');
  assert.deepEqual(await chapter(), ['Before.', 'above', 'scene-break|***', 'below', 'After.']);
});

test('cc on a scene break turns it into an empty paragraph to write in', async () => {
  await load('<p>Before.</p><p class="scene-break">***</p><p>After.</p>');
  await at(1, 0);
  await type('ccMiddle.<Esc>');
  assert.deepEqual(await chapter(), ['Before.', 'Middle.', 'After.']);
});

test('dd on a scene break removes it, the prose around it stays', async () => {
  await load('<p>Before.</p><p class="scene-break">***</p><p>After.</p>');
  await at(1, 0);
  await type('dd');
  assert.deepEqual(await chapter(), ['Before.', 'After.']);
  await type('u');
  assert.deepEqual(await chapter(), ['Before.', 'scene-break|***', 'After.']);
});

test('dd just below a scene break leaves the break alone', async () => {
  await load('<p>Before.</p><p class="scene-break">***</p><p>After.</p><p>Last.</p>');
  await at(2, 3);
  await type('dd');
  assert.deepEqual(await chapter(), ['Before.', 'scene-break|***', 'Last.']);
});

test('visual d from prose into a scene break does not stain the break', async () => {
  await load('<p>Before.</p><p class="scene-break">***</p><p>After.</p>');
  await at(0, 3);
  await type('vjjd');
  const c = await chapter();
  assert.ok(c.every((p) => !p.startsWith('scene-break|') || p === 'scene-break|***'), c.join(' / '));
});

/* ---------- a register that keeps what the clipboard can't ---------- */

test('dd then p moves a paragraph with its italics and bold', async () => {
  await load('<p>One <i>two</i> <b>three</b>.</p><p>Four.</p><p>Five.</p>');
  await at(0, 0);
  await type('ddp');
  assert.deepEqual(await chapter(), ['Four.', 'One <i>two</i> <b>three</b>.', 'Five.']);
  assert.deepEqual(await caret(), [1, 0]);
});

test('yy then P copies a poetry line as poetry', async () => {
  await load('<p class="poetry"><i>A line of verse</i></p><p>Prose.</p>');
  await at(1, 0);
  await type('kyyjP');
  assert.deepEqual(await chapter(), ['poetry|<i>A line of verse</i>', 'poetry|<i>A line of verse</i>', 'Prose.']);
});

test('dd then p moves a scene break as a scene break', async () => {
  await load('<p>One.</p><p class="scene-break">***</p><p>Two.</p>');
  await at(1, 0);
  await type('ddp');
  assert.deepEqual(await chapter(), ['One.', 'Two.', 'scene-break|***']);
});

test('dd then p keeps a flag and its note', async () => {
  await load('<p>One.</p><p>Flag <span class="ph-mark" data-sid="s-test" contenteditable="false">⚑</span> here.</p><p>Two.</p>');
  await js(`stickies.push({ id: 's-test', chapterId: book.chapterOrder[0], text: 'the note', resolved: false })`);
  await at(1, 0);
  await type('ddp');
  const c = await chapter();
  assert.equal(c[2], 'Flag <span class="ph-mark" data-sid="s-test" contenteditable="false">⚑</span> here.');
  assert.equal(await js(`stickies.filter((s) => s.id === 's-test').length`), 1);
});

test('yiw then P keeps italics inside a paragraph', async () => {
  await load('<p>Say <i>hello</i> now.</p>');
  await at(0, 5);
  await type('yiw0P');
  assert.deepEqual(await chapter(), ['<i>hello</i>Say <i>hello</i> now.']);
});

test('p after copying elsewhere pastes the clipboard, not the register', async () => {
  await load('<p>One.</p><p>Two.</p>');
  await at(0, 0);
  await type('yy');
  clipboard.writeText('outside');
  await at(1, 0);
  await type('P');
  assert.deepEqual(await chapter(), ['One.', 'outsideTwo.']);
});

test('keys typed right after p act on what p pasted', async () => {
  await load('<p>One.</p><p>Two.</p>');
  await at(0, 0);
  await type('yypx');
  assert.deepEqual(await chapter(), ['One.', 'ne.', 'Two.']);
});

test('p pastes the clipboard when the same words come with other formatting', async () => {
  await load('<p>Say <i>hello</i> now.</p>');
  await at(0, 5);
  await type('yiw');
  clipboard.write({ text: 'hello', html: '<b>hello</b>' });
  await type('0P');
  assert.deepEqual(await chapter(), ['<b>hello</b>Say <i>hello</i> now.']);
  await load('<p>Say <i>hello</i> now.</p>');
  await at(0, 5);
  await type('yiw');
  clipboard.writeText('hello');
  await type('0P');
  assert.deepEqual(await chapter(), ['helloSay <i>hello</i> now.']);
});

test('p after the clipboard was cleared never pastes vim’s old copy', async () => {
  await load('<p>One.</p>');
  await at(0, 0);
  await type('yy');
  clipboard.clear(); // a clipboard manager may put back what it held before
  await type('p');
  assert.notDeepEqual(await chapter(), ['One.', 'One.']);
});

test('p right after x on a flag or *** pastes nothing, not an older yank', async () => {
  await load('<p>OLD</p><p>Flag<span class="ph-mark" data-sid="s-p" contenteditable="false">⚑</span> here.</p><p class="scene-break">***</p><p>End.</p>');
  await js(`stickies.push({ id: 's-p', chapterId: book.chapterOrder[0], text: '', resolved: false })`);
  await at(0, 0);
  await type('yy');
  await at(1, 4);
  await type('xp');
  assert.deepEqual(await chapter(), ['OLD', 'Flag here.', 'scene-break|***', 'End.']);
  await at(2, 0);
  await type('xp');
  assert.deepEqual(await chapter(), ['OLD', 'Flag here.', 'End.']);
  await type('p'); // no longer right after x: the yank again
  assert.deepEqual(await chapter(), ['OLD', 'Flag here.', 'End.', 'OLD']);
});

test('x does not replace the clipboard, and xp swaps two letters', async () => {
  await load('<p>Tihs.</p>');
  clipboard.writeText('kept');
  await at(0, 1);
  await type('xp');
  assert.deepEqual(await chapter(), ['This.']);
  assert.equal(clipboard.readText(), 'kept');
});

test('ddp then u twice puts everything back', async () => {
  await load('<p>One <i>two</i>.</p><p>Three.</p><p>Four.</p>');
  await at(0, 0);
  await type('ddp');
  await type('uu');
  assert.deepEqual(await chapter(), ['One <i>two</i>.', 'Three.', 'Four.']);
});

test('v across paragraphs, y, then p splits a paragraph around the text', async () => {
  await load('<p>Alpha <i>beta</i></p><p>gamma delta</p><p>Here.</p>');
  await at(0, 6);
  await type('vwey');
  await at(2, 3);
  await type('p');
  assert.deepEqual(await chapter(), ['Alpha <i>beta</i>', 'gamma delta', 'Here<i>beta</i>', 'gamma.']);
});

test('V over a scene break, y, then p brings the break along', async () => {
  await load('<p>One.</p><p class="scene-break">***</p><p>Two.</p>');
  await at(0, 0);
  await type('Vjy');
  await at(2, 0);
  await type('p');
  assert.deepEqual(await chapter(), ['One.', 'scene-break|***', 'Two.', 'One.', 'scene-break|***']);
});

test('p of rich text copied outside NEO keeps bold and italics', async () => {
  await load('<p>Here.</p>');
  clipboard.write({ text: 'bold and it', html: '<meta charset="utf-8"><b>bold</b> and <span style="font-style: italic">it</span>' });
  await at(0, 3);
  await type('p');
  assert.deepEqual(await chapter(), ['Here<b>bold</b> and <i>it</i>.']);
});

test('p of several lines of plain text makes paragraphs', async () => {
  await load('<p>Here.</p>');
  clipboard.writeText('first\nsecond');
  await at(0, 3);
  await type('p');
  assert.deepEqual(await chapter(), ['Herefirst', 'second.']);
});

test('a pasted copy of an outline section leaves the section link behind', async () => {
  await load('<p data-sec-id="sec-1">Written section.</p><p>Next.</p>');
  await at(0, 0);
  await type('yyjp');
  assert.deepEqual(await chapter(), ['Written section.', 'Next.', 'Written section.']);
  assert.equal(await js(`document.querySelectorAll('[data-sec-id="sec-1"]').length`), 1);
});

/* ---------- operators across paragraphs ---------- */

test('dj deletes this paragraph and the next', async () => {
  await load('<p>One.</p><p>Two.</p><p>Three.</p>');
  await at(0, 1);
  await type('dj');
  assert.deepEqual(await chapter(), ['Three.']);
  await type('u');
  assert.deepEqual(await chapter(), ['One.', 'Two.', 'Three.']);
});

test('dk deletes this paragraph and the one above', async () => {
  await load('<p>One.</p><p>Two.</p><p>Three.</p>');
  await at(2, 1);
  await type('dk');
  assert.deepEqual(await chapter(), ['One.']);
});

test('2yy then p copies two paragraphs', async () => {
  await load('<p>One.</p><p>Two.</p><p>Three.</p>');
  await at(0, 0);
  await type('2yyjjp');
  assert.deepEqual(await chapter(), ['One.', 'Two.', 'Three.', 'One.', 'Two.']);
});

test('3cc replaces three paragraphs with one', async () => {
  await load('<p>One.</p><p>Two.</p><p>Three.</p><p>Four.</p>');
  await at(0, 0);
  await type('3ccNew.<Esc>');
  assert.deepEqual(await chapter(), ['New.', 'Four.']);
});

test('dG and dgg stop at the chapter’s edge', async () => {
  await load('<p>One.</p><p>Two.</p><p>Three.</p>');
  await at(1, 0);
  await type('dG');
  assert.deepEqual(await chapters(), [['One.'], ['Chapter two starts here.']]);
  await load('<p>One.</p><p>Two.</p><p>Three.</p>', '<p>Four.</p><p>Five.</p>');
  await at(4, 0);
  await type('dgg');
  assert.deepEqual(await chapters(), [['One.', 'Two.', 'Three.'], ['<br>']]);
});

test('d2w runs on into the next paragraph', async () => {
  await load('<p>One two</p><p>three four</p>');
  await at(0, 4);
  await type('d2w');
  assert.deepEqual(await chapter(), ['One four']);
});

test('dw on a paragraph’s last word stops at its end', async () => {
  await load('<p>One two</p><p>three four</p>');
  await at(0, 4);
  await type('dw');
  assert.deepEqual(await chapter(), ['One ', 'three four']);
});

test('db at a paragraph’s start joins it to the one above', async () => {
  await load('<p>One two</p><p>three four</p>');
  await at(1, 0);
  await type('db');
  assert.deepEqual(await chapter(), ['One three four']);
});

test('a mouse selection across paragraphs goes with d', async () => {
  await load('<p>One two</p><p>three four</p>');
  await js(`(() => {
    const ps = document.querySelectorAll('.chapter-body > p');
    ps[0].closest('.chapter-body').focus();
    const r = document.createRange();
    r.setStart(ps[0].firstChild, 4);
    r.setEnd(ps[1].firstChild, 6);
    getSelection().removeAllRanges();
    getSelection().addRange(r);
  })()`);
  await type('d');
  assert.deepEqual(await chapter(), ['One four']);
});

test('dd on a chapter’s last paragraph leaves the next chapter alone', async () => {
  await load('<p>One.</p><p>Two.</p>', '<p>Three.</p>');
  await at(1, 0);
  await type('5dd');
  assert.deepEqual(await chapters(), [['One.'], ['Three.']]);
});

/* ---------- undo ---------- */

test('3dd comes back with one u, even from a chapter’s first paragraph', async () => {
  await load('<p>One.</p><p>Two.</p><p>Three.</p><p>Four.</p>');
  await at(0, 0);
  await type('3dd');
  assert.deepEqual(await chapter(), ['Four.']);
  await type('u');
  assert.deepEqual(await chapter(), ['One.', 'Two.', 'Three.', 'Four.']);
});

test('u and Ctrl+R undo and redo x', async () => {
  await load('<p>Word.</p>');
  await at(0, 0);
  await type('x');
  assert.deepEqual(await chapter(), ['ord.']);
  await type('u');
  assert.deepEqual(await chapter(), ['Word.']);
  await type('<C-r>');
  assert.deepEqual(await chapter(), ['ord.']);
});

/* ---------- flags ---------- */

test('x on a flag clears the flag and its note', async () => {
  await load('<p>Flag<span class="ph-mark" data-sid="s-x" contenteditable="false">⚑</span> here.</p>');
  await js(`stickies.push({ id: 's-x', chapterId: book.chapterOrder[0], text: 'note', resolved: false })`);
  await at(0, 4);
  await type('x');
  assert.deepEqual(await chapter(), ['Flag here.']);
});

test('u brings back a flag x cleared, and its note; Ctrl+R and ⌘Z follow', async () => {
  await load('<p>Flag<span class="ph-mark" data-sid="s-u" contenteditable="false">⚑</span> here.</p>');
  await js(`stickies.push({ id: 's-u', chapterId: book.chapterOrder[0], text: 'the note', resolved: false })`);
  const note = () => js(`(stickies.find((s) => s.id === 's-u') || {}).text || null`);
  const flag = '<span class="ph-mark" data-sid="s-u" contenteditable="false">⚑</span>';
  await at(0, 4);
  await type('x');
  assert.deepEqual([await chapter(), await note()], [['Flag here.'], null]);
  await type('u');
  assert.deepEqual([await chapter(), await note()], [[`Flag${flag} here.`], 'the note']);
  await type('<C-r>');
  assert.deepEqual([await chapter(), await note()], [['Flag here.'], null]);
  await type('<D-z>');
  assert.deepEqual([await chapter(), await note()], [[`Flag${flag} here.`], 'the note']);
});

test('dw next to a flag never cuts inside it', async () => {
  await load('<p>Word <span class="ph-mark" data-sid="s-y" contenteditable="false">⚑</span> more.</p>');
  await at(0, 0);
  await type('dw');
  assert.deepEqual(await chapter(), ['<span class="ph-mark" data-sid="s-y" contenteditable="false">⚑</span> more.']);
});

/* ---------- motions and text objects ---------- */

test('j crosses into the next chapter', async () => {
  await load('<p>One.</p>', '<p>Two.</p>');
  await at(0, 0);
  await type('j');
  assert.deepEqual(await caret(), [1, 0]);
});

test('ciw, caw, ci" and da( edit what they should', async () => {
  await load('<p>Say “quite so” (really) now.</p>');
  await at(0, 7);
  await type('ci"very<Esc>');
  assert.deepEqual(await chapter(), ['Say “very” (really) now.']);
  await at(0, 12);
  await type('da(');
  assert.deepEqual(await chapter(), ['Say “very”  now.']);
  await at(0, 0);
  await type('ciwSo<Esc>');
  assert.deepEqual(await chapter(), ['So “very”  now.']);
  await at(0, 13);
  await type('caw!<Esc>');
  assert.deepEqual(await chapter(), ['So “very”!.']);
});

/* ---------- ; , r J { } ( ) ---------- */

test('; and , repeat f and t either way, alone or after d', async () => {
  await load('<p>a,b,c,d</p>');
  await at(0, 0);
  await type('f,;');
  assert.deepEqual(await caret(), [0, 3]);
  await type(',');
  assert.deepEqual(await caret(), [0, 1]);
  await type('d;');
  assert.deepEqual(await chapter(), ['ac,d']);
});

test('f and r take Space as the letter it is, and Enter drops them', async () => {
  await load('<p>one two</p>');
  await at(0, 0);
  await type('f x');
  assert.deepEqual(await chapter(), ['onetwo']);
  await type('r<Enter>x');
  assert.deepEqual(await chapter(), ['onewo']);
  await type('r ');
  assert.deepEqual(await chapter(), ['one o']);
});

test('r replaces letters and keeps their italics, but not on a *** or past the end', async () => {
  await load('<p>A <i>cat</i> sat.</p><p class="scene-break">***</p>');
  await at(0, 2);
  await type('rb');
  assert.deepEqual(await chapter(), ['A <i>bat</i> sat.', 'scene-break|***']);
  await type('3rz');
  assert.deepEqual(await chapter(), ['A <i>zzz</i> sat.', 'scene-break|***']);
  await at(0, 8);
  await type('9rq');
  await at(1, 1);
  await type('rx');
  assert.deepEqual(await chapter(), ['A <i>zzz</i> sat.', 'scene-break|***']);
});

test('} { ) ( move by paragraph and sentence', async () => {
  await load('<p>One. Two three.</p><p>Four five.</p>');
  await at(0, 6);
  const steps = [];
  for (const k of [')', '(', '(', '}', '}', '{', '{']) { await type(k); steps.push(await caret()); }
  assert.deepEqual(steps, [[1, 0], [0, 5], [0, 0], [0, 14], [1, 9], [1, 0], [0, 0]]);
  await type('d)');
  assert.deepEqual(await chapter(), ['Two three.', 'Four five.']);
  await type('d}');
  assert.deepEqual(await chapter(), ['<br>', 'Four five.']);
});

test('J joins paragraphs with one space, u splits them again', async () => {
  await load('<p>One</p><p>  <i>two</i></p><p>three</p><p class="scene-break">***</p><p>Four</p>');
  await at(0, 0);
  await type('J');
  assert.deepEqual(await chapter(), ['One <i>two</i>', 'three', 'scene-break|***', 'Four']);
  assert.deepEqual(await caret(), [0, 3]);
  await type('u');
  assert.deepEqual(await chapter(), ['One', '  <i>two</i>', 'three', 'scene-break|***', 'Four']);
  await at(0, 0);
  await type('5J');
  assert.deepEqual(await chapter(), ['One <i>two</i> three', 'scene-break|***', 'Four']);
  await at(2, 0);
  await type('J');
  assert.deepEqual(await chapter(), ['One <i>two</i> three', 'scene-break|***', 'Four']);
  await load('<p>One.</p><p>Two.</p><p>Three.</p>');
  await at(0, 0);
  await type('VjJ');
  assert.deepEqual(await chapter(), ['One. Two.', 'Three.']);
});

/* ---------- plain files ---------- */

test('what the edits leave is what lands on disk and comes back on reopening', async () => {
  await load('<p>One <i>two</i>.</p><p class="scene-break">***</p><p class="poetry"><i>Verse</i></p><p>Flag<span class="ph-mark" data-sid="s-f" contenteditable="false">⚑</span> end.</p><p>Four</p><p>five 😀</p>');
  await js(`stickies.push({ id: 's-f', chapterId: book.chapterOrder[0], text: 'kept', resolved: false })`);
  await at(0, 0);
  await type('ddp');   // a paragraph with italics moves below the ***
  await at(0, 0);
  await type('xu');    // the *** goes and comes back
  await at(4, 0);
  await type('J');     // Four five 😀
  const expected = ['scene-break|***', 'One <i>two</i>.', 'poetry|<i>Verse</i>',
    'Flag<span class="ph-mark" data-sid="s-f" contenteditable="false">⚑</span> end.', 'Four five 😀'];
  assert.deepEqual(await chapter(), expected);

  const [bookId, chId] = await js('[book.id, book.chapterOrder[0]]');
  const file = path.join(tmp, 'NEO Library', bookId, 'chapters', chId + '.html');
  const parse = (html) => js(`(() => {
    const h = document.createElement('div');
    h.innerHTML = ${JSON.stringify(html)};
    return [...h.children].map((p) => (p.className ? p.className + '|' : '') + p.innerHTML);
  })()`);
  await js('flushAllSaves(); 0');
  let onDisk = null;
  for (let n = 0; n < 50; n++) { // the write goes through the main process
    onDisk = await parse(fs.readFileSync(file, 'utf8'));
    if (JSON.stringify(onDisk) === JSON.stringify(expected)) break;
    await tick(100);
  }
  assert.deepEqual(onDisk, expected);

  await js('backToShelf(); 0');
  await tick(300);
  await js(`openBook(${JSON.stringify(bookId)})`);
  await tick(300);
  const reopened = await js(`[...document.querySelectorAll('.chapter-body')[0].children].map((p) => (p.className ? p.className + '|' : '') + p.innerHTML)`);
  assert.deepEqual(reopened, expected);
});

/* ---------- the outline ---------- */

// the outline's sections for chapter one, and NEO's sync of their ghosts
async function outline(sections) {
  await js(`book.sectionNotes = { [book.chapterOrder[0]]: ${JSON.stringify(sections)} }; 0`);
}
const syncGhosts = () => js(`syncGhosts(book.chapterOrder[0]); 0`);

test('J never merges an outline ghost into prose, so the outline never doubles it', async () => {
  // an empty chapter: NEO puts no *** before the first ghost
  await load('<p><br></p><p class="ghost" data-sec-id="sec-g">Outline note</p>');
  await outline([{ id: 'sec-g', text: 'Outline note' }]);
  await at(0, 0);
  await type('J');
  await syncGhosts();
  const c = await chapter();
  assert.equal(c.filter((p) => p.includes('Outline note')).length, 1, c.join(' / '));
});

test('J and d stop at an outline section’s first paragraph', async () => {
  const html = '<p>Before.</p><p data-sec-id="sec-w">Section starts.</p>';
  await load(html);
  await outline([{ id: 'sec-w', text: 'Note' }]);
  await at(0, 0);
  await type('J');
  assert.deepEqual(await chapter(), ['Before.', 'Section starts.']);
  await at(0, 6);
  await type('d2w');
  await syncGhosts();
  const c = await chapter();
  assert.equal(await js(`document.querySelectorAll('.chapter-body [data-sec-id="sec-w"]').length`), 1);
  assert.ok(!c.some((p) => p.startsWith('ghost|')), c.join(' / '));
});

/* ---------- characters longer than one code unit ---------- */

test('x then p on an emoji moves it whole', async () => {
  await load('<p>a😀b</p>');
  await at(0, 1);
  await type('xp');
  assert.deepEqual(await chapter(), ['ab😀']);
});

test('yank and paste take an accented letter or a family emoji whole', async () => {
  await load('<p>ae\u0301b 👩‍👩‍👧 c</p>');
  await at(0, 1);
  await type('yl$p');
  assert.deepEqual(await chapter(), ['ae\u0301b 👩‍👩‍👧 ce\u0301']);
  await at(0, 5);
  await type('vy0P');
  assert.deepEqual(await chapter(), ['👩‍👩‍👧ae\u0301b 👩‍👩‍👧 ce\u0301']);
});

// what the review of Omawrite's vim mode swept for: no key splits a character
test('no motion or edit splits a character', async () => {
  const docs = ['a😀b 😀😀 c', 'ae\u0301 👩‍👩‍👧 x', '🇫🇷 ✌️ ok'];
  const keys = ['x', 'xp', 'lx', 'llx', 'ex', 'wx', 'bx', 'lvd', 'vlly$p', 'ylP', 'd2l', 'ce!<Esc>', 'a!<Esc>', '$x', 'tcx', 'ylp'];
  for (const doc of docs) {
    for (const k of keys) {
      await load(`<p>${doc}</p>`);
      await at(0, 0);
      await type(k);
      await clean();
    }
  }
});

test('a huge count stops where the motion does', async () => {
  await load('<p>One two.</p><p>Three.</p>', '<p>Four.</p>');
  await at(0, 0);
  const t0 = Date.now();
  await type('999999999j');
  assert.deepEqual(await caret(), [2, 0]);
  await type('999999999w999999999b999999999x999999999u');
  assert.ok(Date.now() - t0 < 5000, `took ${Date.now() - t0} ms`);
});

test('dj on a chapter’s last paragraph and dk on its first do nothing', async () => {
  await load('<p>One.</p><p>Two.</p>');
  await at(1, 0);
  await type('dj');
  await at(0, 0);
  await type('dk');
  assert.deepEqual(await chapter(), ['One.', 'Two.']);
});

/* ---------- modes ---------- */

test('the hint shows visual mode and a half typed command', async () => {
  await load('<p>One.</p><p>Two.</p>');
  await at(0, 0);
  await type('V');
  assert.equal(await hint(), 'VISUAL LINE');
  await type('<Esc>d');
  assert.equal(await hint(), 'd');
  await type('<Esc>');
  assert.equal(await hint(), '');
});

test('turning Vim Mode off and on again drops a half typed command', async () => {
  await load('<p>One.</p>');
  await at(0, 0);
  await type(':w');
  await js(`library.vim = false; NeoVim.apply(); library.vim = true; NeoVim.apply(); 0`);
  assert.equal(await hint(), '');
  await type('x');
  assert.deepEqual(await chapter(), ['ne.']);
});

test('a command Vim Mode lacks says so instead of doing nothing', async () => {
  await load('<p>One two.</p>');
  await at(0, 0);
  await type('~');
  assert.equal(await hint(), '~ isn’t in NEO’s Vim Mode');
  await type('dit');
  assert.equal(await hint(), 'dit isn’t in NEO’s Vim Mode');
  assert.deepEqual(await chapter(), ['One two.']);
  await type('<Esc>');
});

test('Esc stays in the book, :q goes back to the shelf', async () => {
  await load('<p>One.</p>');
  await at(0, 0);
  await type('<Esc>');
  assert.equal(await js(`document.getElementById('editor-view').hidden`), false);
  const id = await js('book.id');
  await type(':q<Enter>');
  await tick(300);
  assert.equal(await js(`document.getElementById('editor-view').hidden`), true);
  await js(`openBook(${JSON.stringify(id)})`);
  await tick(300);
});

/* ---------- keyboards that type with modifiers or compose ---------- */

// a key that types ch with modifiers: ⌥ on a Mac, AltGr on Windows
async function typeWith(modifiers, keyCode, ch) {
  wc.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
  wc.sendInputEvent({ type: 'char', keyCode: ch, modifiers });
  wc.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
  await tick();
}
// a dead key or an input method: text composed, then committed
async function compose(pre, text) {
  await wc.debugger.sendCommand('Input.imeSetComposition', { text: pre, selectionStart: pre.length, selectionEnd: pre.length });
  await wc.debugger.sendCommand('Input.insertText', { text });
  await tick(80);
}

test('normal mode: ⌥ and AltGr characters never land in the text', async () => {
  await load('<p>One two.</p>');
  await at(0, 0);
  await typeWith(['alt'], '-', '–');             // ⌥- on a Mac
  await typeWith(['control', 'alt'], '7', '{');  // AltGr+7 on a German Windows keyboard
  assert.deepEqual(await chapter(), ['One two.']);
});

test('normal mode: a dead key or input method never lands in the text', async () => {
  await load('<p>One two.</p>');
  await at(0, 0);
  await type('x');
  await compose('´', 'é');
  assert.deepEqual(await chapter(), ['ne two.']);
  assert.equal(await hint(), 'é isn’t in NEO’s Vim Mode');
  assert.deepEqual(await caret(), [0, 0]);
  await type('u'); // the x, not the é
  assert.deepEqual(await chapter(), ['One two.']);
});

test('ci" works where " is a dead key (US International, Dutch, Portuguese)', async () => {
  await load('<p>Say "quite so" now.</p>');
  await at(0, 7);
  await type('ci');
  await compose('"', '"');
  await type('very<Esc>');
  assert.deepEqual(await chapter(), ['Say "very" now.']);
});

test('insert mode: ⌥, AltGr and dead keys type as always', async () => {
  await load('<p>One.</p>');
  await at(0, 4);
  await type('a');
  await typeWith(['alt'], '-', '–');
  await compose('´', 'é');
  await type('<Esc>');
  assert.deepEqual(await chapter(), ['One.–é']);
});

/* ---------- with Vim Mode off, NEO is NEO ---------- */

// Each of NEO's own gestures runs twice, with vim.js loaded but off and
// with window.NeoVim gone (as in Pocket, where app.js's hooks are inert),
// and both runs must end the same.
async function withoutVim(html, n, off, keys) {
  const runs = [];
  for (const loaded of [true, false]) {
    await js(`window.NeoVim = ${loaded ? 'window.vimForTests' : 'undefined'}; 0`);
    await load(html, undefined, false);
    await at(n, off);
    if (typeof keys === 'function') await keys(); else await type(keys);
    const shelf = await js(`document.getElementById('editor-view').hidden`);
    runs.push({ chapters: await chapters(), caret: shelf ? null : await caret(), shelf });
    if (shelf) { await js(`openBook(vimTestBook)`); await tick(300); }
  }
  await js(`window.NeoVim = window.vimForTests; 0`);
  assert.deepEqual(runs[0], runs[1], 'vim.js, while off, changed what NEO did');
  return runs[0];
}

test('off: vim keys are just letters', async () => {
  const r = await withoutVim('<p>Text.</p>', 0, 4, 'ddxp u:q<Enter>ZZ vV');
  assert.deepEqual(r.chapters[0], ['Textddxp u:q', 'ZZ vV.']);
});

test('off: Enter twice makes a scene break, three times a chapter', async () => {
  const r = await withoutVim('<p>One. Two.</p>', 0, 4, '<Enter><Enter>');
  assert.ok(r.chapters[0].includes('scene-break|***'), r.chapters[0].join(' / '));
  const c = await withoutVim('<p>One. Two.</p>', 0, 4, '<Enter><Enter><Enter>');
  assert.equal(c.chapters.length, 3);
});

test('off: Backspace below a scene break removes it', async () => {
  const r = await withoutVim('<p>One.</p><p class="scene-break">***</p><p>Two.</p>', 2, 0, '<BS>');
  assert.deepEqual(r.chapters[0], ['One.', 'Two.']);
});

test('off: undo, Tab and bold work as before', async () => {
  const u = await withoutVim('<p>One.</p>', 0, 4, ' more<D-z>');
  assert.notDeepEqual(u.chapters[0], ['One. more']);
  const t = await withoutVim('<p>One.</p>', 0, 0, '<Tab>');
  assert.deepEqual(t.chapters[0], ['\u2003\u2003One.']);
  const b = await withoutVim('<p>One.</p>', 0, 4, '<D-b>bold');
  assert.deepEqual(b.chapters[0], ['One.<b>bold</b>']);
});

test('off: ⌥, AltGr and dead keys type as always', async () => {
  const r = await withoutVim('<p>One.</p>', 0, 4, async () => {
    await typeWith(['alt'], '-', '–');
    await compose('´', 'é');
  });
  assert.deepEqual(r.chapters[0], ['One.–é']);
});

test('off: Esc goes back to the shelf', async () => {
  const r = await withoutVim('<p>One.</p>', 0, 0, '<Esc>');
  assert.equal(r.shelf, true);
});

/* ---------- runner ---------- */

async function main() {
  await app.whenReady();
  const saved = { text: clipboard.readText(), html: clipboard.readHTML() };
  let failed = 0;
  try {
    let win;
    while (!(win = BrowserWindow.getAllWindows()[0])) await tick(50);
    wc = win.webContents;
    wc.debugger.attach('1.3'); // for input-method keys
    while (!(await js(`typeof library !== 'undefined' && !!library`).catch(() => false))) await tick(50);
    await js(`(async () => {
      document.getElementById('firstrun').hidden = true;
      library.firstRunDone = true;
      await addImportedBooks([{ name: 'Vim', chapters: [
        { title: 'One', paras: [{ text: 'x' }] },
        { title: 'Two', paras: [{ text: 'y' }] }
      ] }], library.shelves[0]);
      const ids = library.shelves[0].bookIds;
      window.vimTestBook = ids[ids.length - 1];
      window.vimForTests = window.NeoVim;
      await openBook(vimTestBook);
      window.vimTestChapters = [...book.chapterOrder];
    })()`);
    await tick(300);
    win.focus();
    const only = process.argv.slice(2).find((a) => !a.startsWith('-')); // npm test -- "dd then|off:"
    const run = tests.filter((x) => !only || only.split('|').some((o) => x.name.includes(o)));
    for (const t of run) {
      try {
        await t.fn();
        await clean();
        console.log('ok   ' + t.name);
      } catch (err) {
        failed++;
        console.log('FAIL ' + t.name + '\n     ' + String(err.message).replace(/\n/g, '\n     '));
      }
    }
    console.log(`\n${run.length - failed} passed, ${failed} failed`);
  } catch (err) {
    failed++;
    console.error(err);
  } finally {
    clipboard.write(saved);
    app.exit(failed ? 1 : 0);
  }
}
main();
