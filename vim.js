/* ============================ VIM MODE ============================ */
// View → Vim Mode: modal editing for the manuscript, off by default.
// Loaded after app.js, whose helpers it uses; exposes window.NeoVim.
// Pocket doesn't load it, so the hooks in app.js stay inert there.

'use strict';

(() => {
  let on = false;
  let mode = 'normal';     // 'normal' | 'insert' | 'visual'
  let pending = '';        // keys of an unfinished command: 3dw, gg, fa, ciw…
  let xChar = '';          // x keeps its character here, off the clipboard
  let lastFind = null;     // the last f, t, F or T, for ; and ,
  let lastWasX = false;    // p right after x pastes xChar, so xp swaps letters
  let xTook = false;       // x removed something (a flag or *** leaves xChar empty)
  let reg = null;          // what d, c and y last took, whole: { html, text, lines }
  let vis = null;          // visual mode: { line, a, h }, anchor and head as { p, off }
  let ex = null;           // a :command being typed, shown in NEO's hint pill

  const sel = () => window.getSelection();

  function apply() {
    on = !!(library && library.vim);
    mode = 'normal';
    pending = '';
    vis = null;
    ex = null;
    if (window.neo.vimState) window.neo.vimState(on); // the View menu's tick
    paint();
  }
  // Like Obsidian's: before vim keys take over the page, the writer shows
  // they know the way back out. Every answer here works in NEO too.
  const WAYS_OUT = ['ZZ', 'ZQ', ...['q', 'q!', 'wq', 'wq!', 'x', 'x!', 'qa', 'qa!', 'wqa', 'xa'].map((c) => ':' + c)];
  async function knowsTheWayOut() {
    let title = 'Before Vim Mode: how do you quit Vim?';
    for (;;) {
      const answer = await askInput(title, 'The command, as you’d type it');
      if (answer === null) return false;
      if (WAYS_OUT.includes(answer)) return true;
      if (WAYS_OUT.includes(':' + answer)) { title = 'Almost. Vim wants the colon first.'; continue; }
      toast('That wouldn’t get you out of Vim. Vim Mode stays off.');
      return false;
    }
  }
  async function toggle() {
    if (!library.vim) {
      const caret = captureCaret();
      const ok = await knowsTheWayOut();
      restoreCaret(caret);
      if (!ok) { apply(); return; } // stays off, and so does the menu's tick
    }
    library.vim = !library.vim;
    window.neo.writeLibrary(library);
    apply();
    toast(on ? 'Vim mode on. Esc to move around, i to write.' : 'Vim mode off');
  }

  function setMode(m) {
    mode = m;
    pending = '';
    if (ex !== null) hideEx();
    paint();
  }

  const allParas = () => Array.from(document.querySelectorAll('.chapter-body > p'));
  function nextPara(p) { const a = allParas(); return a[a.indexOf(p) + 1] || null; }
  function prevPara(p) { const a = allParas(); return a[a.indexOf(p) - 1] || null; }

  function here() {
    const p = focusParagraph();
    return p ? { p, off: caretOffsetIn(p) } : null;
  }
  const len = (p) => p.textContent.length;
  const isBreak = (p) => !!p && p.classList.contains('scene-break');
  // A *** and an outline ghost are single units, never merged with prose,
  // and an outline section's first paragraph (data-sec-id) is never merged
  // into the one before it: the outline would lose track of the section
  // and put its ghost back.
  const isUnit = (p) => isBreak(p) || (!!p && p.classList.contains('ghost'));
  const startsSection = (p) => !!(p && p.dataset.secId);
  const indexIn = (p) => Array.prototype.indexOf.call(p.parentElement.children, p);
  function focusBody(p) {
    const body = p.closest('.chapter-body');
    if (body && document.activeElement !== body) body.focus({ preventScroll: true });
  }

  // placeholder flags and darling anchors are single, uneditable marks:
  // a point is before one or after it, never inside
  const markOf = (n) => (n && (n.nodeType === Node.TEXT_NODE ? n.parentElement : n).closest('.ph-mark, .darling-anchor')) || null;
  function pointAt(p, off) {
    const r = rangeFromOffsets(p, Math.min(off, len(p)), Math.min(off, len(p)));
    if (!r) return [p, 0];
    const m = markOf(r.startContainer);
    if (!m) return [r.startContainer, r.startOffset];
    const i = Array.prototype.indexOf.call(m.parentNode.childNodes, m);
    return [m.parentNode, r.startOffset > 0 ? i + 1 : i];
  }
  function rangeOf(a, b) {
    const r = document.createRange();
    r.setStart(...pointAt(a.p, a.off));
    r.setEnd(...pointAt(b.p, b.off));
    return r;
  }
  function place(p, off) {
    focusBody(p);
    const r = rangeOf({ p, off }, { p, off });
    const s = sel();
    s.removeAllRanges();
    s.addRange(r);
  }
  // Offsets step by character as the page shows it: an emoji, an accented
  // letter or a flag is one, however many code units it takes, so no
  // motion or edit ever splits one.
  let graphemes = null;
  function charEnd(t, off) {
    if (off >= t.length) return t.length;
    if (!graphemes) graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
    const g = graphemes.segment(t).containing(Math.max(0, off));
    return g.index + g.segment.length;
  }
  function charStart(t, off) {
    if (off <= 0 || off >= t.length) return Math.max(0, Math.min(off, t.length));
    if (!graphemes) graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
    return graphemes.segment(t).containing(off).index;
  }
  const stepBack = (t, off) => (off > 0 ? charStart(t, off - 1) : 0);
  const whole = (t, off) => (charStart(t, off) === off ? off : charEnd(t, off));

  // normal mode sits ON a character, never after the last one
  function clamp() {
    const h = here();
    const t = h && h.p.textContent;
    if (h && h.off > 0 && h.off >= t.length) place(h.p, stepBack(t, t.length));
  }
  // keep the caret on screen (typewriter scrolling does its own following)
  function reveal() {
    if (typeof typewriterEnabled !== 'undefined' && typewriterEnabled) return;
    const s = sel();
    if (!s.rangeCount) return;
    const rs = s.getRangeAt(0).getClientRects();
    let r = rs[rs.length - 1];
    if (!r) { const p = focusParagraph(); if (!p) return; r = p.getBoundingClientRect(); }
    const sc = document.getElementById('paper-scroll');
    const v = sc.getBoundingClientRect();
    const pad = 60;
    if (r.top < v.top + pad) sc.scrollTop -= v.top + pad - r.top;
    else if (r.bottom > v.bottom - pad) sc.scrollTop += r.bottom - (v.bottom - pad);
  }

  // Normal mode shows a block caret. Visual mode and a half-typed command
  // (7d, ci, g, :wq) show in NEO's hint pill, as on vim's bottom line.
  let shown = '';
  function paint() {
    document.body.classList.toggle('vim-normal', on && mode === 'normal');
    const text = !on ? '' : ex !== null ? ':' + ex
      : [mode === 'visual' ? (vis && vis.line ? 'VISUAL LINE' : 'VISUAL') : '', pending].filter(Boolean).join(' ');
    const hint = document.getElementById('hint');
    if (text) {
      toast(text, 10 * 60 * 1000);
      shown = text;
    } else if (shown) {
      // leave anyone else's message alone
      if (hint.textContent === shown) { clearTimeout(toast._t); hint.hidden = true; }
      shown = '';
    }
  }

  // Like vim's word/WORD split: letters (with apostrophes, so don’t is one
  // word, and accents), punctuation, and the spaces between them.
  const WORD = /[\p{L}\p{M}\p{N}_'’]/u;
  const kind = (c) => (!c || /\s/.test(c) ? 0 : WORD.test(c) ? 1 : 2);

  function wordFwd({ p, off }) {
    const t = p.textContent;
    let i = off;
    const k = kind(t[i]);
    if (k) while (i < t.length && kind(t[i]) === k) i++;
    while (i < t.length && kind(t[i]) === 0) i++;
    if (i < t.length) return { p, off: whole(t, i) };
    const n = nextPara(p);
    if (!n) return { p, off: t.length, end: true };
    const nt = n.textContent;
    let j = 0;
    while (j < nt.length && kind(nt[j]) === 0) j++;
    return { p: n, off: j < nt.length ? j : 0 };
  }
  function wordEnd({ p, off }) {
    let t = p.textContent;
    let i = charEnd(t, off);
    for (;;) {
      while (i < t.length && kind(t[i]) === 0) i++;
      if (i < t.length) break;
      const n = nextPara(p);
      if (!n) return { p, off };
      p = n; t = p.textContent; i = 0;
    }
    const k = kind(t[i]);
    while (i + 1 < t.length && kind(t[i + 1]) === k) i++;
    return { p, off: charStart(t, i) };
  }
  function wordBack({ p, off }) {
    let t = p.textContent;
    let i = off - 1;
    for (;;) {
      while (i >= 0 && kind(t[i]) === 0) i--;
      if (i >= 0) break;
      const q = prevPara(p);
      if (!q) return { p, off: 0 };
      p = q; t = p.textContent; i = t.length - 1;
    }
    const k = kind(t[i]);
    while (i > 0 && kind(t[i - 1]) === k) i--;
    return { p, off: charStart(t, i) };
  }
  // the run under the caret (word, punctuation or spaces), for iw and cw
  function innerWord({ p, off }) {
    const t = p.textContent;
    if (!t.length) return null;
    const i = Math.min(off, t.length - 1);
    const k = kind(t[i]);
    let a = i, b = i + 1;
    while (a > 0 && kind(t[a - 1]) === k) a--;
    while (b < t.length && kind(t[b]) === k) b++;
    return [charStart(t, a), whole(t, b)];
  }

  // Each gives [start, end) within the caret's paragraph; ip and ap are
  // dd's paragraph and are handled there.

  let segmenter = null;
  function sentences(t) {
    if (!segmenter) segmenter = new Intl.Segmenter((library.spellLanguage || 'en').split('-')[0], { granularity: 'sentence' });
    return segmenter.segment(t);
  }
  function sentenceAt(t, off, around) {
    for (const seg of sentences(t)) {
      const end = seg.index + seg.segment.length;
      if (off < end || end === t.length) {
        return [seg.index, around ? end : seg.index + seg.segment.replace(/\s+$/, '').length];
      }
    }
    return null;
  }
  // straight quotes pair up in order: 1st with 2nd, 3rd with 4th…
  function straightQuoted(t, off, q) {
    const at = [];
    for (let i = 0; i < t.length; i++) if (t[i] === q) at.push(i);
    for (let k = 0; k + 1 < at.length; k += 2) if (off <= at[k + 1]) return [at[k], at[k + 1]];
    return null;
  }
  // “…” and (…) nest; outside any pair, the next pair on the paragraph
  function enclosed(t, off, o, c) {
    let depth = 0, a = -1;
    for (let i = Math.min(off, t.length - 1); i >= 0; i--) {
      if (t[i] === c && i !== off) depth++;
      else if (t[i] === o) { if (!depth) { a = i; break; } depth--; }
    }
    if (a < 0) { a = t.indexOf(o, off); if (a < 0) return null; }
    depth = 0;
    for (let i = a + 1; i < t.length; i++) {
      if (t[i] === o) depth++;
      else if (t[i] === c) { if (!depth) return [a, i]; depth--; }
    }
    return null;
  }
  function textObject(obj, h) {
    const r = objectRange(obj, h);
    const t = h.p.textContent;
    return r && [charStart(t, r[0]), whole(t, r[1])];
  }
  function objectRange(obj, h) {
    const t = h.p.textContent;
    const around = obj[0] === 'a';
    const what = obj[1];
    if (what === 'w') {
      const w = innerWord(h);
      if (!w || !around) return w;
      let [a, b] = w;
      if (kind(t[a]) === 0) { // on spaces: the spaces and the word after them
        const k = kind(t[b]);
        while (b < t.length && k && kind(t[b]) === k) b++;
        return [a, b];
      }
      if (kind(t[b]) === 0 && b < t.length) while (b < t.length && kind(t[b]) === 0) b++;
      else while (a > 0 && kind(t[a - 1]) === 0) a--; // no space after: take the one before
      return [a, b];
    }
    if (what === 's') return sentenceAt(t, h.off, around);
    let pair = null;
    if (what === '"') {
      const curly = enclosed(t, h.off, '“', '”');
      const straight = straightQuoted(t, h.off, '"');
      const holds = (r) => r && r[0] <= h.off && h.off <= r[1];
      pair = holds(curly) ? curly : holds(straight) ? straight : curly || straight;
    } else if ('()b'.includes(what)) pair = enclosed(t, h.off, '(', ')');
    if (!pair) return null;
    let [a, b] = pair;
    if (!around) return [a + 1, b];
    b++;
    // a" takes the space after the quote too (or before, at a paragraph's end)
    if (what === '"') {
      if (b < t.length && /\s/.test(t[b])) while (b < t.length && /\s/.test(t[b])) b++;
      else while (a > 0 && /\s/.test(t[a - 1])) a--;
    }
    return [a, b];
  }

  function caretTop() {
    // at a wrap the caret has two boxes: the end of the line above, then the
    // start of its own line; the last one is where it sits
    const s = sel();
    const rs = s.rangeCount ? s.getRangeAt(0).getClientRects() : [];
    if (rs.length) return rs[rs.length - 1].top;
    const p = focusParagraph();
    return p ? p.getBoundingClientRect().top : 0;
  }
  // j / k: by wrapped line; at a chapter's edge, on into the next one
  function lineMove(dir) {
    const s = sel();
    if (!s.rangeCount) return;
    const h = here();
    if (!h) return;
    const top = caretTop();
    s.modify('move', dir, 'line');
    // on the first or last line the engine slides along the line instead;
    // half a line of slack, since a drop cap's box sits above its line
    const half = (parseFloat(getComputedStyle(h.p).lineHeight) || 30) / 2;
    if (Math.abs(caretTop() - top) > half) return;
    place(h.p, h.off);
    const edge = dir === 'forward' ? h.p.closest('.chapter-body').lastElementChild : h.p.closest('.chapter-body').firstElementChild;
    const next = dir === 'forward' ? nextPara(edge) : prevPara(edge);
    if (!next) return;
    if (dir === 'forward') place(next, 0);
    else {
      place(next, next.textContent.length);
      sel().modify('move', 'backward', 'lineboundary');
    }
  }
  // } and {: to the last letter of the paragraph (or of the next one, when
  // already there) and to the first (or the previous one's first)
  function paraEnd({ p, off }) {
    const last = stepBack(p.textContent, len(p));
    if (off < last) return { p, off: last };
    const n = nextPara(p);
    return n ? { p: n, off: stepBack(n.textContent, len(n)) } : { p, off };
  }
  function paraStart({ p, off }) {
    if (off > 0) return { p, off: 0 };
    const q = prevPara(p);
    return q ? { p: q, off: 0 } : { p, off };
  }
  // ) and (: to the start of the next sentence, and of this one (or the
  // previous one, when already there), on across paragraphs
  function sentenceFwd({ p, off }) {
    const s = [...sentences(p.textContent)].find((g) => g.index > off);
    if (s) return { p, off: s.index };
    const n = nextPara(p);
    return n ? { p: n, off: 0 } : { p, off: len(p) };
  }
  function sentenceBack({ p, off }) {
    const s = [...sentences(p.textContent)].filter((g) => g.index < off).pop();
    if (s) return { p, off: s.index };
    const q = prevPara(p);
    const last = q && [...sentences(q.textContent)].pop();
    return q ? { p: q, off: last ? last.index : 0 } : { p, off: 0 };
  }
  // count lines down or up, stopping at the book's edge
  function lines(count, dir) {
    for (let n = 0; n < count; n++) {
      const h = here();
      lineMove(dir);
      const t = here();
      if (!h || !t || (t.p === h.p && t.off === h.off)) break;
    }
  }
  function lineEdge(dir) {
    sel().modify('move', dir, 'lineboundary');
    if (dir !== 'forward') return;
    // $ lands on the last character, not after it (or after a wrap's space)
    const h = here();
    if (!h || h.off === 0) return;
    const t = h.p.textContent;
    let o = stepBack(t, h.off);
    if (o > 0 && /\s/.test(t[o])) o = stepBack(t, o);
    place(h.p, o);
  }

  // a fresh paragraph is prose, like one made with Enter: no scene break's,
  // ghost's or poem's styling carried over
  function cleanNewPara() {
    const p = focusParagraph();
    if (!p) return;
    if (p.classList.contains('poetry')) romanize(p);
    p.classList.remove('scene-break', 'ghost', 'poetry');
    if (!p.className) p.removeAttribute('class');
    p.removeAttribute('style');
  }
  function openLine(below) {
    const h = here();
    if (!h) return;
    place(h.p, below ? h.p.textContent.length : 0);
    document.execCommand('insertParagraph');
    if (!below) place(prevPara(focusParagraph()) || h.p, 0);
    cleanNewPara();
    setMode('insert');
  }
  // The register holds what d, c and y took as the manuscript's own HTML,
  // so italics, flags, poems and *** survive a round trip. The system
  // clipboard gets the same; p pastes the register while the clipboard
  // holds exactly what vim put there, and the clipboard otherwise.

  const norm = (t) => t.replace(/\r/g, '').replace(/\u00a0/g, ' ').replace(/\s*\n\s*/g, '\n').trim();
  function setReg(html, text, lines) {
    reg = { html, lines };
    window.neo.writeClipboard({ text, html });
  }
  const parasFrom = (first, last) => {
    const ps = [];
    for (let p = first; p; p = p.nextElementSibling) { ps.push(p); if (p === last) break; }
    return ps;
  };
  function yankParas(first, last) {
    const ps = parasFrom(first, last);
    setReg(ps.map((p) => p.outerHTML).join(''), ps.map((p) => p.textContent).join('\n'), true);
  }
  function yankText(a, b) {
    const box = document.createElement('div');
    box.append(rangeOf(a, b).cloneContents());
    const ps = box.querySelectorAll(':scope > p');
    setReg(box.innerHTML, ps.length ? [...ps].map((p) => p.textContent).join('\n') : box.textContent, false);
  }

  // Paragraph-sized edits replace the paragraphs first..last with html in
  // one engine step: one u undoes it, and nothing merges into a neighbor,
  // which the engine would restyle (a neighbor that must stay is put back
  // as it was).
  function replaceParas(first, last, html) {
    focusBody(first);
    const r = document.createRange();
    r.setStart(first, 0);
    r.setEnd(last, last.childNodes.length);
    const s = sel();
    s.removeAllRanges();
    s.addRange(r);
    document.execCommand('insertHTML', false, html);
    reconcileMarks();
  }
  // dd, 3dd, dj, Vd: the caret lands on the paragraph after them
  function deleteParas(first, last, copy = true) {
    if (copy) yankParas(first, last);
    const body = first.parentElement;
    const i = indexIn(first);
    const prev = first.previousElementSibling;
    const next = last.nextElementSibling;
    if (prev) replaceParas(prev, last, prev.outerHTML);
    else if (next) replaceParas(first, next, next.outerHTML);
    else replaceParas(first, last, '<p><br></p>'); // the whole chapter
    place(body.children[Math.min(i, body.children.length - 1)], 0);
  }
  // cc, 3cc, cj, Vc: one empty paragraph to write in, a poem's line stays verse
  function changeParas(first, last) {
    yankParas(first, last);
    const body = first.parentElement;
    const i = indexIn(first);
    const blank = isBreak(first) ? document.createElement('p') : first.cloneNode(false);
    blank.innerHTML = blank.classList.contains('poetry') ? '<i><br></i>' : '<br>';
    replaceParas(first, last, blank.outerHTML);
    caretIntoStart(body.children[i]);
    setMode('insert');
  }

  // r: the letters under the caret become ch and keep their italics; a ***
  // or a flag takes no letters
  function replaceChars(h, ch, count) {
    const t = h.p.textContent;
    let b = h.off;
    for (let n = 0; n < count; n++) {
      if (b >= t.length) return; // like vim, not enough letters is no change
      b = charEnd(t, b);
    }
    const r = rangeOf(h, { p: h.p, off: b });
    if (isBreak(h.p) || [...h.p.querySelectorAll('.ph-mark, .darling-anchor')].some((m) => r.intersectsNode(m))) return;
    const s = sel();
    s.removeAllRanges();
    s.addRange(r);
    healSelectionSeams(h.p.parentElement);
    document.execCommand('insertText', false, ch.repeat(count));
    place(h.p, stepBack(h.p.textContent, h.off + ch.length * count));
  }
  // J, 3J, VJ: the paragraphs from p join into one, a space at each seam,
  // in one undo step. Like vim, a chapter's last paragraph joins nothing,
  // and neither does a *** or the outline (see isUnit).
  function joinParas(p, count) {
    let last = p;
    for (let n = 0; n < Math.max(1, count - 1); n++) {
      const next = last.nextElementSibling;
      if (!next || isUnit(next) || startsSection(next)) break;
      last = next;
    }
    if (last === p || isUnit(p)) return;
    const out = p.cloneNode(false);
    let seam = 0;
    for (let q = p; ; q = q.nextElementSibling) {
      const t = q.textContent;
      const from = q === p ? 0 : t.length - t.trimStart().length;
      if (q !== p) {
        seam = out.textContent.length;
        if (hasText(out) && t.trim() && !/\s$/.test(out.textContent)) out.append(' ');
      }
      out.append(rangeOf({ p: q, off: from }, { p: q, off: len(q) }).cloneContents());
      if (q === last) break;
    }
    if (!hasText(out)) out.innerHTML = '<br>';
    const body = p.parentElement;
    const i = indexIn(p);
    replaceParas(p, last, out.outerHTML);
    place(body.children[i], seam);
  }

  // what an operator covers: { lines: [first, last] }, or { from, to } as
  // { p, off } points; either way inside the caret's chapter
  function target(op, rest, h, count) {
    const ps = [...h.p.parentElement.children];
    const i = ps.indexOf(h.p);
    const lines = (a, b) => ({ lines: [ps[Math.max(0, a)], ps[Math.min(ps.length - 1, b)]] });
    // a paragraph is a line here, so ip and ap act like dd cc yy
    if (rest === op || rest === 'ip' || rest === 'ap') return lines(i, i + count - 1);
    if (rest === 'j') return i < ps.length - 1 ? lines(i, i + count) : null; // like vim, fails on the last
    if (rest === 'k') return i > 0 ? lines(i - count, i) : null;
    if (rest === 'G') return lines(i, ps.length - 1);
    if (rest === 'gg') return lines(0, i);
    if (/^[ia].$/.test(rest)) {
      const r = textObject(rest, h);
      return r && { from: { p: h.p, off: r[0] }, to: { p: h.p, off: r[1] } };
    }
    if (op === 'c' && rest === 'w' && kind(h.p.textContent[h.off])) {
      return { from: h, to: { p: h.p, off: innerWord(h)[1] } }; // cw on a word changes to its end, like ce
    }
    const t = motion(rest, h, count);
    if (!t) return null;
    if (t.moved) place(h.p, h.off);
    let to = { p: t.p, off: t.incl ? charEnd(t.p.textContent, t.off) : t.off };
    if (!ps.includes(to.p)) {
      const back = to.p.compareDocumentPosition(h.p) & Node.DOCUMENT_POSITION_FOLLOWING;
      to = back ? { p: ps[0], off: 0 } : { p: ps[ps.length - 1], off: len(ps[ps.length - 1]) };
    } else if (rest === 'w' && to.p !== h.p && !/\S/.test(to.p.textContent.slice(0, to.off))) {
      // like vim, dw on a paragraph's last word stops at its end
      const p = to.p.previousElementSibling;
      to = { p, off: len(p) };
    }
    const before = to.p === h.p ? to.off < h.off : ps.indexOf(to.p) < i;
    return before ? { from: to, to: h } : { from: h, to };
  }

  const hasText = (p) => !!(p.textContent || p.querySelector('.ph-mark'));
  function operate(op, t) {
    if (t.lines) {
      const [first, last] = t.lines;
      if (op === 'y') { yankParas(first, last); if (first !== focusParagraph()) place(first, 0); }
      else if (op === 'd') deleteParas(first, last);
      else changeParas(first, last);
      return;
    }
    let a = t.from, b = t.to;
    if (a.p === b.p && a.off >= b.off) return;
    // a *** is one unit: whatever touches it takes all of it
    if (a.p === b.p && isBreak(a.p)) { operate(op, { lines: [a.p, a.p] }); return; }
    if (isUnit(a.p)) a = { p: a.p, off: 0 };
    if (isUnit(b.p)) b = { p: b.p, off: len(b.p) };
    yankText(a, b);
    if (op === 'y') { place(a.p, a.off); return; }
    if (a.p === b.p) {
      const s = sel();
      s.removeAllRanges();
      s.addRange(rangeOf(a, b));
      healSelectionSeams(a.p.parentElement);
      document.execCommand('delete');
      reconcileMarks();
    } else {
      // across paragraphs: a's start and b's end join into one paragraph,
      // unless b starts an outline section, which keeps its own
      const head = !isUnit(a.p) && a.p.cloneNode(false);
      const tail = !isUnit(b.p) && b.p.cloneNode(false);
      if (head) head.append(rangeOf({ p: a.p, off: 0 }, a).cloneContents());
      if (tail) tail.append(rangeOf(b, { p: b.p, off: len(b.p) }).cloneContents());
      let out = [head, tail].filter(Boolean);
      if (!out.length) { operate(op, { lines: [a.p, b.p] }); return; }
      const seam = head ? head.textContent.length : 0;
      if (head && tail && !startsSection(b.p)) { head.append(...tail.childNodes); out = [head]; }
      else if (head && tail && !hasText(head)) out = [tail];
      for (const p of out) if (!hasText(p)) p.innerHTML = '<br>';
      const body = a.p.parentElement;
      const i = indexIn(a.p);
      replaceParas(a.p, b.p, out.map((p) => p.outerHTML).join(''));
      place(body.children[i], out[0] === head ? seam : 0);
    }
    if (op === 'c') setMode('insert');
  }

  // a pasted copy leaves the outline's links with the paragraph it copies
  function fresh(html) {
    const box = document.createElement('div');
    box.innerHTML = html;
    for (const attr of ['data-sec-id', 'data-sec-brk']) {
      for (const el of box.querySelectorAll(`[${attr}]`)) {
        if (!document.querySelector(`.chapter-body [${attr}="${CSS.escape(el.getAttribute(attr))}"]`)) continue;
        el.removeAttribute(attr);
        el.classList.remove('ghost');
        if (!el.className) el.removeAttribute('class');
      }
    }
    return box;
  }
  function put(r, after) {
    const h = here();
    if (!h) return;
    const box = fresh(r.html);
    const blocks = [...box.querySelectorAll(':scope > p')];
    const body = h.p.parentElement;
    const i = indexIn(h.p);
    if (r.lines || isBreak(h.p)) {
      // paragraphs go in beside this one, which is put back as it was
      const html = blocks.length ? box.innerHTML : `<p>${box.innerHTML || '<br>'}</p>`;
      replaceParas(h.p, h.p, after ? h.p.outerHTML + html : html + h.p.outerHTML);
      place(body.children[i + (after ? 1 : 0)], 0);
      return;
    }
    // the paragraph is rebuilt around the text: the engine's own insert
    // wraps it in a style span
    const at = after ? charEnd(h.p.textContent, h.off) : h.off;
    const head = h.p.cloneNode(false);
    const tail = h.p.cloneNode(false);
    tail.removeAttribute('data-sec-id'); // the section starts where it did
    head.append(rangeOf({ p: h.p, off: 0 }, { p: h.p, off: at }).cloneContents());
    tail.append(rangeOf({ p: h.p, off: at }, { p: h.p, off: len(h.p) }).cloneContents());
    if (!blocks.length) {
      const n = box.textContent.length;
      head.append(...box.childNodes, ...tail.childNodes);
      replaceParas(h.p, h.p, head.outerHTML);
      const p = body.children[i];
      place(p, stepBack(p.textContent, at + n)); // on the last pasted letter, as in vim
      return;
    }
    // several paragraphs: this one splits around them
    if (!isUnit(blocks[0]) && !startsSection(blocks[0])) head.append(...blocks.shift().childNodes);
    if (blocks.length && !isUnit(blocks[blocks.length - 1])) tail.prepend(...blocks.pop().childNodes);
    const out = [head, ...blocks, tail];
    if (!hasText(head) && isBreak(out[1])) out.shift();
    if (!hasText(tail) && isBreak(out[out.length - 2])) out.pop();
    for (const p of out) if (!hasText(p)) p.innerHTML = '<br>';
    replaceParas(h.p, h.p, out.map((p) => p.outerHTML).join(''));
    place(body.children[i], out[0] === head ? at : 0);
  }
  function paste(after) {
    const h = here();
    if (!h) return;
    if (lastWasX) {
      if (!xChar) return; // x took a flag or a ***, not a letter
      const at = after ? charEnd(h.p.textContent, h.off) : h.off;
      place(h.p, at);
      document.execCommand('insertText', false, xChar);
      place(h.p, stepBack(h.p.textContent, at + xChar.length));
      return;
    }
    const { text, html, vims } = window.neo.readClipboard();
    if (reg && vims) put(reg, after);
    else if (text) {
      // copied from elsewhere since: cleaned the way ⌘V cleans it
      const lines = text.replace(/\r/g, '').split(/\n+/).filter((l) => l.trim()).map((l) => escHtml(l.trim()));
      // a Mac offers plain text as its own "HTML"; only markup counts
      const rich = html && html !== text && /<[a-z]/i.test(html);
      put({ html: rich ? cleanPasteHtml(html) : lines.length > 1 ? lines.map((l) => `<p>${l}</p>`).join('') : lines.join(''), lines: false }, after);
    }
    clamp();
    paint();
  }
  function undo() {
    // right after a chapter or scene break, ⌘Z belongs to the structural stack
    if (breakRun > 0 && undoStack.length) { breakRun--; structuralUndo(); return true; }
    if (!document.queryCommandEnabled('undo')) return false;
    document.execCommand('undo');
    afterHistory();
    return true;
  }
  // the engine's undo/redo leaves the restored text selected; vim sits at
  // the start of the change
  function afterHistory() {
    const s = sel();
    if (s.rangeCount && !s.isCollapsed) s.collapseToStart();
    followFlags();
  }

  // x on a flag clears it, note and all, as Backspace does. The flag goes
  // through the engine, so u, Ctrl+R and ⌘Z bring it back and take it
  // away again, and its note comes and goes with it.
  const clearedNotes = new Map(); // sid → the note of a flag x cleared
  function clearFlag(h, m) {
    const sid = m.classList.contains('ph-mark') ? m.dataset.sid : '';
    const note = sid && stickies.find((s) => s.id === sid);
    if (note) clearedNotes.set(sid, note);
    const marks = '.ph-mark, .darling-anchor';
    const out = h.p.cloneNode(true);
    const gone = out.querySelectorAll(marks)[[...h.p.querySelectorAll(marks)].indexOf(m)];
    const before = gone.previousSibling;
    const after = gone.nextSibling;
    gone.remove();
    // one space at the seam, not two (resolveSticky's rule)
    if (before && after && before.nodeType === Node.TEXT_NODE && after.nodeType === Node.TEXT_NODE &&
        /[ \u00a0]$/.test(before.data) && /^[ \u00a0]/.test(after.data)) after.data = after.data.slice(1);
    const body = h.p.parentElement;
    const i = indexIn(h.p);
    replaceParas(h.p, h.p, out.outerHTML);
    if (sid) resolveSticky(sid); // the note, now that its flag is gone
    place(body.children[i], h.off);
  }
  function followFlags() {
    let changed = false;
    for (const [sid, note] of clearedNotes) {
      const flag = document.querySelector(`.chapter-body .ph-mark[data-sid="${CSS.escape(sid)}"]`);
      const at = stickies.findIndex((s) => s.id === sid);
      if (flag && at < 0) { stickies.push(note); changed = true; }
      else if (!flag && at >= 0) { clearedNotes.set(sid, stickies[at]); stickies.splice(at, 1); changed = true; }
    }
    if (!changed) return;
    window.neo.writeJSON(book.id, 'stickies', stickies);
    renderStickies();
    scheduleNavRefresh();
  }
  // ⌘Z and the Edit menu undo without vim
  document.addEventListener('input', (e) => {
    if (e.inputType === 'historyUndo' || e.inputType === 'historyRedo') followFlags();
  }, true);

  function motion(m, h, count) {
    let t = { p: h.p, off: h.off };
    const text = h.p.textContent;
    const findChar = (ch, fwd, till) => {
      let o = t.off;
      for (let n = 0; n < count; n++) {
        const i = fwd ? text.indexOf(ch, o + 1 + (till && n === 0 ? 1 : 0)) : text.lastIndexOf(ch, o - 1 - (till && n === 0 ? 1 : 0));
        if (i < 0) return null;
        o = i;
      }
      return { p: h.p, off: till ? (fwd ? stepBack(text, o) : charEnd(text, o)) : o, incl: fwd };
    };
    const find = (cmd, ch) => findChar(ch, 'ft'.includes(cmd), 'tT'.includes(cmd));
    // a count runs until the motion stops moving: 999999999w ends at the end
    const repeat = (step) => {
      for (let n = 0; n < count; n++) {
        const next = step(t);
        if (next.p === t.p && next.off === t.off) break;
        t = next;
      }
      return t;
    };
    switch (m[0]) {
      case 'h': return repeat(({ p, off }) => ({ p, off: stepBack(text, off) }));
      case 'l': return repeat(({ p, off }) => ({ p, off: charEnd(text, off) }));
      case 'w': return repeat(wordFwd);
      case 'b': return repeat(wordBack);
      case 'e': return { ...repeat(wordEnd), incl: true };
      case 'f': case 't': case 'F': case 'T':
        lastFind = { cmd: m[0], ch: m[1] };
        return find(m[0], m[1]);
      case ';': return lastFind && find(lastFind.cmd, lastFind.ch);
      case ',': return lastFind && find({ f: 'F', F: 'f', t: 'T', T: 't' }[lastFind.cmd], lastFind.ch);
      case '}': return { ...repeat(paraEnd), incl: true };
      case '{': return repeat(paraStart);
      case ')': return repeat(sentenceFwd);
      case '(': return repeat(sentenceBack);
      case '0': lineEdge('backward'); return { ...here(), moved: true };
      case '$': lineEdge('forward'); return { ...here(), incl: true, moved: true };
      default: return null;
    }
  }

  // what the motions and text objects are, so the rest can say they aren't
  const MOTION = /^(?:[hlwbe0$jkG;,{}()]|gg|[fFtT].)$/;
  const OBJECT = /^[ia][wsp"()b]$/;
  const unknown = (keys) => toast(`${keys} isn’t in NEO’s Vim Mode`, 2500);

  // runs pending as a command; returns false while it still needs keys
  function exec(count, op, rest) {
    const h = here();
    if (!h) return true;
    const needsMore = /^[gZfFtTr]$/.test(rest) || (op && (rest === 'i' || rest === 'a'));
    if (needsMore) return false;

    if (op) {
      const t = target(op, rest, h, count);
      if (t) operate(op, t);
      else if (!MOTION.test(rest) && !OBJECT.test(rest)) unknown(pending);
      return true;
    }

    const end = len(h.p);
    if (/^r.$/.test(rest)) { replaceChars(h, rest[1], count); return true; }
    // a *** takes no words: writing starts on a new line beside it
    if (isBreak(h.p) && 'iIaA'.includes(rest)) { openLine('aA'.includes(rest)); return true; }
    switch (rest) {
      case 'i': setMode('insert'); return true;
      case 'a': place(h.p, charEnd(h.p.textContent, h.off)); setMode('insert'); return true;
      case 'I': place(h.p, 0); setMode('insert'); return true;
      case 'A': place(h.p, end); setMode('insert'); return true;
      case 'J': joinParas(h.p, count); return true;
      case 'o': openLine(true); return true;
      case 'O': openLine(false); return true;
      case 'x': {
        xChar = '';
        xTook = false;
        if (isBreak(h.p)) { deleteParas(h.p, h.p, false); xTook = true; return true; }
        const r = rangeFromOffsets(h.p, h.off, charEnd(h.p.textContent, h.off));
        const m = r && markOf(r.endContainer);
        if (m) { clearFlag(h, m); xTook = true; return true; }
        let b = h.off;
        for (let n = 0; n < count && b < end; n++) b = charEnd(h.p.textContent, b);
        if (b <= h.off) return true;
        xChar = h.p.textContent.slice(h.off, b);
        xTook = true;
        const s = sel();
        s.removeAllRanges();
        s.addRange(rangeOf(h, { p: h.p, off: b }));
        healSelectionSeams(h.p.parentElement);
        document.execCommand('delete');
        reconcileMarks();
        return true;
      }
      case 'D': operate('d', { from: h, to: { p: h.p, off: end } }); return true;
      case 'C': operate('c', { from: h, to: { p: h.p, off: end } }); return true;
      case 'p': paste(true); return true;
      case 'P': paste(false); return true;
      case 'u': for (let n = 0; n < count && undo(); n++); return true;
      case 'j': lines(count, 'forward'); return true;
      case 'k': lines(count, 'backward'); return true;
      case 'gg': { const p = allParas()[0]; if (p) place(p, 0); return true; }
      case 'G': { const a = allParas(); if (a.length) place(a[a.length - 1], 0); return true; }
      case 'ZZ': case 'ZQ': backToShelf(); return true; // NEO has always saved
      case 'v': startVisual(false); return true;
      case 'V': startVisual(true); return true;
    }
    if (!MOTION.test(rest)) { unknown(pending); return true; }
    const t = motion(rest, h, count);
    if (t && !t.moved) place(t.p, t.off);
    return true;
  }

  function run(k) {
    pending += k;
    const m = pending.match(/^([1-9]\d*)?([dcy])?([1-9]\d*)?(.*)$/);
    if (!m[4]) return; // a count or an operator on its own: wait
    const count = (+(m[1] || 1)) * (+(m[3] || 1));
    const wasX = m[4] === 'x' && !m[2];
    if (!exec(count, m[2] || '', m[4])) return;
    pending = '';
    lastWasX = wasX && xTook;
    if (mode === 'normal') clamp();
    reveal();
    paint();
  }

  // The selection is the engine's own, drawn from an anchor and a head that
  // the motions move. Like vim, v includes the letter under the head. A
  // selection stays inside its chapter: each chapter is its own editing
  // host and the engine won't delete across two.

  function startVisual(line) {
    const h = here();
    if (!h) return;
    vis = { line, a: { ...h }, h: { ...h } };
    setMode('visual');
    drawVisual();
  }
  function endVisual(to) {
    const h = vis && (to || vis.h);
    vis = null;
    setMode('normal');
    if (h && h.p.isConnected) place(h.p, Math.min(h.off, stepBack(h.p.textContent, h.p.textContent.length)));
    clamp();
    paint();
  }
  function ordered() {
    const { a, h } = vis;
    const first = a.p === h.p ? a.off <= h.off : !!(a.p.compareDocumentPosition(h.p) & Node.DOCUMENT_POSITION_FOLLOWING);
    return first ? [a, h] : [h, a];
  }
  // what the selection covers, as an operator's target
  function visualTarget() {
    const [s0, e0] = ordered();
    return vis.line ? { lines: [s0.p, e0.p] } : { from: s0, to: { p: e0.p, off: charEnd(e0.p.textContent, e0.off) } };
  }
  function drawVisual() {
    const t = visualTarget();
    const r = t.lines ? rangeOf({ p: t.lines[0], off: 0 }, { p: t.lines[1], off: len(t.lines[1]) }) : rangeOf(t.from, t.to);
    const s = sel();
    s.removeAllRanges();
    s.addRange(r);
  }

  function runVisual(k) {
    pending += k;
    const m = pending.match(/^([1-9]\d*)?(.*)$/);
    const rest = m[2];
    if (!rest) return;
    const count = +(m[1] || 1);
    if (/^[gfFtTia]$/.test(rest)) return;
    const keys = pending;
    pending = '';
    const { h } = vis;

    if (rest === 'v' || rest === 'V') {
      if (vis.line === (rest === 'V')) endVisual();
      else { vis.line = rest === 'V'; drawVisual(); }
      return;
    }
    if (rest === 'o') { vis = { ...vis, a: vis.h, h: vis.a }; drawVisual(); return; }
    if ('dxcsy'.includes(rest)) { visualOperator(rest); return; }
    if (rest === 'J') {
      const [s0, e0] = ordered();
      const ps = [...s0.p.parentElement.children];
      vis = null;
      setMode('normal');
      joinParas(s0.p, Math.max(2, ps.indexOf(e0.p) - ps.indexOf(s0.p) + 1));
      clamp();
      paint();
      return;
    }
    if (!MOTION.test(rest) && !OBJECT.test(rest)) { unknown(keys); return; }
    if (OBJECT.test(rest)) {
      const r = textObject(rest, h);
      if (r && r[1] > r[0]) { vis.a = { p: h.p, off: r[0] }; vis.h = { p: h.p, off: stepBack(h.p.textContent, r[1]) }; drawVisual(); }
      return;
    }

    // a motion moves the head; line motions need the real caret, so it
    // collapses onto the head, moves, and the selection is drawn again
    place(h.p, h.off);
    let t = null;
    if (rest === 'j' || rest === 'k') { lines(count, rest === 'j' ? 'forward' : 'backward'); t = here(); }
    else if (rest === 'gg') { const p = allParas()[0]; t = p && { p, off: 0 }; }
    else if (rest === 'G') { const a = allParas(); t = a.length && { p: a[a.length - 1], off: 0 }; }
    else {
      t = motion(rest, h, count);
      if (t && t.moved) t = here();
    }
    // stay inside the chapter; the head sits on a letter, not after the last
    if (t && t.p && t.p.parentElement === vis.a.p.parentElement) {
      vis.h = { p: t.p, off: Math.min(t.off, stepBack(t.p.textContent, t.p.textContent.length)) };
      place(vis.h.p, vis.h.off);
      reveal();
    }
    drawVisual();
  }

  function visualOperator(op) {
    const t = visualTarget();
    const start = ordered()[0];
    vis = null;
    setMode('normal');
    operate({ x: 'd', s: 'c' }[op] || op, t);
    if (op === 'y') place(start.p, t.lines ? 0 : start.off);
    if (mode === 'normal') clamp();
    paint();
  }
  // a click or a drag ends visual mode; the mouse's selection is its own
  document.addEventListener('mousedown', () => { if (vis) { vis = null; setMode('normal'); } }, true);

  // a mouse selection in normal mode: x/d cut it, y copies it, c cuts and writes
  function onSelection(k) {
    if (!'xdyc'.includes(k)) return false;
    const r = sel().getRangeAt(0);
    const point = (node, off) => {
      const el = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
      const p = el.closest('.chapter-body > p');
      return p && { p, off: flatOffset(p, node, off) };
    };
    const a = point(r.startContainer, r.startOffset);
    const b = point(r.endContainer, r.endOffset);
    if (!a || !b || a.off < 0 || b.off < 0 || a.p.parentElement !== b.p.parentElement) return true;
    operate(k === 'x' ? 'd' : k, { from: a, to: b });
    if (mode === 'normal') { clamp(); paint(); }
    return true;
  }

  // Just the ways out of vim. NEO saves as you go, so every one of them
  // saves and goes back to the shelf; :w saves on the spot.

  const QUITS = ['q', 'q!', 'wq', 'wq!', 'x', 'x!', 'qa', 'qa!', 'wqa', 'xa'];
  function showEx() { paint(); }
  function hideEx() { ex = null; paint(); }
  function exKey(e) {
    if (e.key === 'Escape' || (e.key === 'Backspace' && !ex)) { hideEx(); return; }
    if (e.key === 'Backspace') { ex = ex.slice(0, -1); showEx(); return; }
    if (e.key === 'Enter') {
      const cmd = ex.trim();
      hideEx();
      if (QUITS.includes(cmd)) backToShelf();
      else if (cmd === 'w') { flushAllSaves(); toast('Saved. NEO saves as you write, too.'); }
      else if (cmd) toast(`:${cmd} isn't a NEO command. :q goes back to the shelf.`);
      return;
    }
    if (e.key.length === 1) { ex += e.key; showEx(); }
  }

  const ALIASES = { Enter: 'j', Backspace: 'h', ' ': 'l', Delete: 'x' };
  // after f, t or r the next key is the letter itself (f then Space finds a
  // space), and a key with no letter just drops the command
  const literal = () => /[fFtTr]$/.test(pending);

  // one character for vim, from a key or from text a keyboard typed
  function feed(k) {
    if (mode === 'visual') runVisual(k);
    else if (ex !== null) ex += k;
    else if (k === ':' && !pending) ex = '';
    else if (pending || sel().isCollapsed || !onSelection(k)) run(k);
    paint();
  }

  // called first in the chapter's keydown chain; true = the key was vim's
  function key(e) {
    if (!on) return false;
    const plain = !e.metaKey && !e.ctrlKey && !e.altKey;
    const take = () => {
      e.preventDefault();
      e.stopPropagation(); // Esc must not reach the go-back-to-the-shelf handler
      enterRun = 0;        // vim keys never count toward Enter-Enter scene breaks
    };
    if (mode === 'insert') {
      if (e.key !== 'Escape' || !plain) return false;
      take();
      const h = here();
      if (h && h.off > 0) place(h.p, stepBack(h.p.textContent, h.off)); // vim steps back onto the last letter
      setMode('normal');
      return true;
    }
    if (mode === 'normal' && e.ctrlKey && !e.metaKey && !e.altKey && e.key === 'r') {
      take();
      document.execCommand('redo');
      afterHistory();
      clamp();
      paint();
      return true;
    }
    if (!plain) return false; // ⌘ and Ctrl shortcuts are NEO's
    if (mode === 'visual') {
      if (e.key === 'Escape') { take(); endVisual(); return true; }
      if (e.key === 'Tab') { take(); return true; }
      const k = literal() ? e.key : ALIASES[e.key] || e.key;
      if (k.length !== 1) { if (!literal()) return false; take(); pending = ''; paint(); return true; }
      take();
      feed(k);
      return true;
    }
    if (ex !== null) { take(); exKey(e); return true; }
    if (e.key === 'Escape') {
      pending = '';
      paint();
      if (!document.getElementById('searchbar').hidden) return false; // let Esc close search
      take();
      window.neo.fullscreenEscape(); // still leaves full screen, never the book
      return true;
    }
    if (e.key === 'Tab') { take(); return true; }
    const k = literal() ? e.key : ALIASES[e.key] || e.key;
    if (k.length !== 1) { if (!literal()) return false; take(); pending = ''; paint(); return true; }
    take();
    feed(k);
    return true;
  }

  // Some keys type without reaching key() as plain keys: ⌥ letters on a Mac,
  // AltGr on Windows, dead keys and input methods (as composition, which
  // the keydown chain leaves alone). Outside insert mode their text goes to
  // vim as keys, never into the manuscript, so a dead-key " still does ci".
  const outsideInsert = (e) => on && mode !== 'insert' && e.target.closest && e.target.closest('.chapter-body');
  document.addEventListener('beforeinput', (e) => {
    if (!outsideInsert(e) || e.inputType !== 'insertText' || !e.data) return;
    e.preventDefault();
    e.stopPropagation();
    for (const k of e.data) feed(k);
  }, true);
  document.addEventListener('compositionstart', (e) => {
    if (!outsideInsert(e) || !sel().rangeCount) return;
    // setting the selection ends the engine's typing run, so the composed
    // text is an undo step of its own and not part of the last x or dw
    const r = sel().getRangeAt(0);
    sel().removeAllRanges();
    sel().addRange(r);
  }, true);
  document.addEventListener('compositionend', (e) => {
    if (!outsideInsert(e) || !e.data) return;
    document.execCommand('undo'); // the composed text comes back out, off the undo history
    afterHistory();
    for (const k of e.data) feed(k);
  }, true);

  window.NeoVim = { key, apply, toggle };
})();
