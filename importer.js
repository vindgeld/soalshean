// importer.js — read quiz questions from PDF / DOCX / TXT, entirely in the browser.
//
//   extractText(file)            -> { text, notes }   (file -> plain text, DOCX bold kept as **line**)
//   parseQuizText(text, opts)    -> { items, docTitle } (text -> editor-ready question objects)
//
// Each item is { q, src, warnings } where `q` matches the editor's in-memory shape:
//   { id, title, type, points, required, options:[{id,text,isCorrect}], answerText, tolerance, explanation }
// Nothing here touches Firestore: the editor's normal Save splits answers into quizKeys.

const MAMMOTH = "https://cdnjs.cloudflare.com/ajax/libs/mammoth/1.6.0/mammoth.browser.min.js";
const PDFJS = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js";
const PDFJS_WORKER = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
const MAX_BYTES = 15 * 1024 * 1024, MAX_PDF_PAGES = 150;

const rnd = () => Math.random().toString(36).substring(2, 7);
const norm = s => String(s ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/\s+/g, " ").trim();

/* ======================================================================
   1. FILE -> TEXT
   ====================================================================== */
const loadScript = src => new Promise((res, rej) => {
  if (document.querySelector(`script[src="${src}"]`)?.dataset.loaded) return res();
  const s = document.createElement("script");
  s.src = src;
  s.onload = () => { s.dataset.loaded = "1"; res(); };
  s.onerror = () => rej(new Error("Could not load a required library. Check your connection and try again."));
  document.head.appendChild(s);
});

export async function extractText(file) {
  const ext = file.name.split(".").pop().toLowerCase();
  if (file.size > MAX_BYTES) throw new Error("File is larger than 15 MB.");
  if (ext === "txt" || ext === "md") return { text: await file.text(), notes: [] };
  if (ext === "docx") return docxToText(file);
  if (ext === "pdf") return pdfToText(file);
  if (ext === "doc") throw new Error("Old .doc files are not supported. Open it in Word, choose Save As → .docx, and try again.");
  throw new Error("Unsupported file type. Use PDF, DOCX or TXT.");
}

/* ---------- DOCX ---------- */
async function docxToText(file) {
  await loadScript(MAMMOTH);
  const { value: html } = await window.mammoth.convertToHtml(
    { arrayBuffer: await file.arrayBuffer() },
    { styleMap: ["u => u"], convertImage: window.mammoth.images.imgElement(() => Promise.resolve({ src: "" })) }
  );
  const notes = [];
  const imgs = (html.match(/<img\b/g) || []).length;
  if (imgs) notes.push(`${imgs} image(s) in the document were skipped. Add images in the editor afterwards.`);
  return { text: htmlToText(html), notes };
}

// Mammoth HTML -> one line per paragraph. Bold/underlined lines are wrapped as **line** so the
// parser can use them as an answer signal. Word auto-numbering (which HTML loses) is rebuilt.
export function htmlToText(html) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const out = [];
  let qCounter = 0;

  const runs = (node, bold, acc) => {
    for (const n of node.childNodes) {
      if (n.nodeType === 3) acc.push({ t: n.textContent, b: bold });
      else if (n.nodeType === 1) {
        const tag = n.tagName;
        if (tag === "BR") acc.push({ t: "\n", b: false });
        else if (tag === "OL" || tag === "UL" || tag === "TABLE" || tag === "IMG") continue;
        else {
          runs(n, bold || tag === "STRONG" || tag === "B" || tag === "U", acc);
          if (tag === "P") acc.push({ t: " ", b: false });
        }
      }
    }
    return acc;
  };

  const emit = (acc, prefix = "") => {
    const lines = [[]];
    for (const r of acc) r.t.split("\n").forEach((p, i) => { if (i) lines.push([]); lines[lines.length - 1].push({ t: p, b: r.b }); });
    lines.forEach((segs, i) => {
      const text = segs.map(s => s.t).join("").replace(/\s+/g, " ").trim();
      if (!text) return;
      const len = s => s.t.replace(/\s/g, "").length;
      const total = segs.reduce((n, s) => n + len(s), 0), b = segs.reduce((n, s) => n + (s.b ? len(s) : 0), 0);
      const line = (i === 0 ? prefix : "") + text;
      out.push(total && b / total >= 0.6 ? `**${line}**` : line);
    });
  };

  // A flat list that mixes stems and options (no nesting in the file): regroup when the pattern is clear,
  // i.e. 2+ stems ending in "?" / ":" / "____" and each followed by 2-8 option-like items.
  const regroup = el => {
    const items = [...el.children].filter(c => c.tagName === "LI");
    const isStem = li => /[?:]\s*$|_{3,}/.test(li.textContent.trim());
    const stems = items.map((li, i) => isStem(li) ? i : -1).filter(i => i >= 0);
    if (stems.length < 2 || stems[0] !== 0) return null;
    const groups = stems.map((s, k) => ({ stem: items[s], opts: items.slice(s + 1, stems[k + 1] ?? items.length) }));
    return groups.every(g => g.opts.length >= 2 && g.opts.length <= 8) ? groups : null;
  };

  const list = (el, depth, asOptions) => {
    const ordered = el.tagName === "OL";
    if (ordered && depth === 0 && !asOptions && !el.querySelector("ol,ul")) {
      const groups = regroup(el);
      if (groups) {
        for (const g of groups) {
          emit(runs(g.stem, false, []), (++qCounter) + ". ");
          g.opts.forEach((li, i) => emit(runs(li, false, []), String.fromCharCode(65 + i) + ") "));
        }
        return;
      }
    }
    let i = 0;
    for (const li of el.children) {
      if (li.tagName !== "LI") continue;
      i++;
      const prefix = !ordered ? "• " : (depth > 0 || asOptions) ? String.fromCharCode(64 + ((i - 1) % 26) + 1) + ") " : (++qCounter) + ". ";
      emit(runs(li, false, []), prefix);
      for (const c of li.children) if (c.tagName === "OL" || c.tagName === "UL") list(c, depth + 1, false);
    }
  };

  for (const n of doc.body.children) {
    const tag = n.tagName;
    if (tag === "OL" || tag === "UL") {
      // A flat numbered list right after "1. Question text" / "...?" is that question's options.
      const prev = n.previousElementSibling, pt = prev ? prev.textContent.trim() : "";
      const nested = !!n.querySelector("ol,ul");
      const asOptions = tag === "OL" && !nested && !!prev && /^(P|H[1-6])$/.test(prev.tagName) && (!!qStart(pt) || /\?\s*$/.test(pt));
      list(n, 0, asOptions);
    } else if (tag === "TABLE") {
      for (const tr of n.querySelectorAll("tr"))
        emit([{ t: [...tr.children].map(c => c.textContent.trim()).join("  "), b: false }]);
    } else emit(runs(n, false, []));
  }
  return out.join("\n");
}

/* ---------- PDF ---------- */
// Rebuild reading-order lines from PDF.js text items (grouped by baseline, spaces by x-gap).
export function itemsToLines(items) {
  const lines = [];
  let cur = "", lastY = null, lastEnd = null;
  const flush = () => { const t = cur.replace(/\s+/g, " ").trim(); if (t) lines.push(t); cur = ""; };
  for (const it of items) {
    if (typeof it.str !== "string") continue;
    const x = it.transform[4], y = it.transform[5];
    if (lastY !== null && Math.abs(y - lastY) > Math.max(2, (it.height || 10) * 0.5)) { flush(); lastEnd = null; }
    else if (lastEnd !== null && x - lastEnd > 1.5 && !cur.endsWith(" ") && !it.str.startsWith(" ")) cur += " ";
    cur += it.str; lastY = y; lastEnd = x + (it.width || 0);
  }
  flush();
  return lines;
}

async function pdfToText(file) {
  await loadScript(PDFJS);
  const pdfjs = window.pdfjsLib;
  pdfjs.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
  const pdf = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
  if (pdf.numPages > MAX_PDF_PAGES) throw new Error(`PDF has ${pdf.numPages} pages (limit ${MAX_PDF_PAGES}). Split it and import in parts.`);
  const lines = [];
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    lines.push(...itemsToLines((await page.getTextContent()).items));
  }
  const text = lines.join("\n");
  if (text.replace(/\s/g, "").length < 20 * pdf.numPages)
    throw new Error("This PDF has little or no selectable text (probably a scan). Export a text-based PDF or DOCX, or paste the text into Bulk Import.");
  return { text, notes: ["PDF bold/underline can't be read. Correct answers must be marked (*, ✓, Answer:) or listed in an answer key."] };
}

/* ======================================================================
   2. TEXT -> QUESTIONS
   ====================================================================== */
const OPT_RE = /^(\*|✓|✔|✅)?\s*\(?([A-Ha-h])[.)\]:]\s+(.+)$/;
const BULLET_RE = /^[•·▪◦–—-]\s+(.+)$/;
const ANS_RE = /^(?:the\s+)?(?:correct\s+)?(?:answer\s*keys?|answers?|ans|key|jawaban|kunci(?:\s+jawaban)?)\s*(?:[:=\-–]|is\b)\s*(.+)$/i;
const KEYHEAD_RE = /^(?:answer\s*keys?|answers|kunci\s*jawaban|jawaban|key)\s*:?$/i;
const EXP_RE = /^(?:explanation|rationale|reason|solution|penjelasan|pembahasan)\s*[:\-–]\s*(.*)$/i;
const SECTION_RE = /^(?:section|part|bagian|bab)\b/i;
const CORRECT_TAIL = /\s*(?:\*|✓|✔|✅|\((?:correct|benar)\))\s*$/i;
const SATA_RE = /select all|choose all|check all|mark all|all that apply|pilih semua|lebih dari satu|more than one|(?:choose|select|pilih)\s+(?:two|three|2|3|dua|tiga)\b/i;
const PAIR_RE = /(\d{1,3})\s*(?:[.):\-=|]\s*|\s+)([A-Ha-h](?:\s*(?:[,&\/;]|and)\s*[A-Ha-h])*)(?![A-Za-z0-9])/g;

function qStart(l) {
  let m = l.match(/^(?:question|soal|q|no\.?)\s*(\d{1,3})\s*[.)\]:\-]?\s*(.*)$/i);
  if (m) return { num: +m[1], rest: m[2] };
  m = l.match(/^(\d{1,3})\s*[.)\]:]\s+(.+)$/) || l.match(/^(\d{1,3})\s*[.)\]:]\s*$/);
  return m ? { num: +m[1], rest: m[2] || "" } : null;
}

// "1. B  2. A  3. C,D" -> [[1,"B"],[2,"A"],[3,"C,D"]] (only if the line is nothing but pairs)
function keyPairs(l) {
  const pairs = [];
  const rest = l.replace(PAIR_RE, (_, n, a) => { pairs.push([+n, a]); return " "; }).replace(/[\s,;|.\-–]+/g, "");
  return rest ? [] : pairs;
}
function asKeyLine(l) {
  let p = keyPairs(l);
  if (p.length >= 2) return p;
  const m = l.match(ANS_RE);
  if (m) { p = keyPairs(m[1]); if (p.length >= 2) return p; }
  return null;
}

// Split "A) x  B) y  C) z" on one line into separate option lines (only if letters run A,B,C…).
function splitInline(l) {
  // "1. Pick one  A) cat  B) dog" -> stem + options (mid-line only trusts the "A)" form)
  const mid = l.match(/^(.*?\S)\s+(\*?\(?[Aa]\)\s.*\s\*?\(?[Bb]\)\s.*)$/);
  if (mid && !/^\*?\s*\(?[Aa][.)]\s/.test(l)) {
    const rest = splitInline(mid[2]);
    if (rest.length >= 2) return [mid[1], ...rest];
  }
  if (!/^\*?\s*\(?[Aa][.)]\s/.test(l)) return [l];
  const parts = l.split(/\s+(?=\*?\(?[B-Hb-h][.)]\s)/);
  if (parts.length < 2) return [l];
  const ok = parts.every((p, i) => (p.match(/\(?([A-Ha-h])[.)]/)?.[1] || "").toUpperCase() === String.fromCharCode(65 + i));
  return ok ? parts : [l];
}

// "B", "B, D", "b and c", "B) Paris", "BD", or option text(s) -> option indexes, else null
function resolveChoice(ans, options) {
  const s = String(ans).trim(), n = options.length, idx = [];
  let m = s.match(/^\(?([A-Ha-h](?:\s*(?:[,&\/;]|\band\b)\s*\(?[A-Ha-h]\)?)*)\)?(?:[.):\s]|$)/);
  if (m) m[1].match(/[A-Ha-h]/g).forEach(c => idx.push(c.toUpperCase().charCodeAt(0) - 65));
  else if (/^[A-H]{2,6}$/.test(s) && new Set(s).size === s.length) [...s].forEach(c => idx.push(c.charCodeAt(0) - 65));
  else {
    for (const part of s.split(/\s*[,;|]\s*/)) {
      const i = options.findIndex(o => norm(o.text) === norm(part.replace(/^\(?[A-Ha-h][.)]\s*/, "")));
      if (i < 0) return null;
      idx.push(i);
    }
  }
  const u = [...new Set(idx)];
  return u.length && u.every(i => i >= 0 && i < n) ? u : null;
}

function finalize(c, points, keyL, keyT, byNum) {
  const warnings = [];
  let title = c.title.replace(/\s+/g, " ").trim();
  if (!title) return null;

  let pts = points;
  const pm = title.match(/[(\[]\s*(\d+(?:\.\d+)?)\s*(?:points?|pts?|marks?|poin|skor)\s*[)\]]/i);
  if (pm) { pts = +pm[1]; title = title.replace(pm[0], "").replace(/\s+/g, " ").trim(); }

  let options = c.options.filter(o => o.text.trim()).map(o => ({ text: o.text.trim(), correct: o.correct, bold: o.bold }));
  let src = "none", answerText = "", tolerance;

  // --- correct-answer signals, in priority order ---
  if (options.some(o => o.correct)) src = "marker on option";
  else {
    const b = options.filter(o => o.bold).length;
    if (b > 0 && b < options.length) { options.forEach(o => o.correct = !!o.bold); src = "bold/underlined option"; }
  }
  const setCorrect = idx => { options.forEach((o, i) => o.correct = idx.includes(i)); };

  if (c.ans != null && c.ans.trim()) {
    if (options.length) {
      const r = resolveChoice(c.ans, options);
      if (r) { setCorrect(r); src = "Answer: line"; } else warnings.push(`Couldn't match “${c.ans.trim().slice(0, 40)}” to an option.`);
    } else { answerText = c.ans.trim(); src = "Answer: line"; }
  }
  if (!options.some(o => o.correct) && !answerText) {
    const letters = byNum ? keyL.get(c.num) : keyL.get(c.index + 1), text = byNum ? keyT.get(c.num) : keyT.get(c.index + 1);
    if (options.length && letters) { const r = resolveChoice(letters, options); if (r) { setCorrect(r); src = "answer key section"; } }
    else if (!options.length && text) { answerText = text.trim(); src = "answer key section"; }
  }

  // --- true/false without option lines ---
  if (!options.length && (/^(true|false|benar|salah)$/i.test(answerText) || /true\s*\/\s*false|benar\s*\/\s*salah|\btrue or false\b/i.test(title))) {
    const id = /benar|salah/i.test(answerText + " " + title);
    options = (id ? ["Benar", "Salah"] : ["True", "False"]).map(t => ({ text: t, correct: false }));
    if (answerText) options[/^(true|benar)$/i.test(answerText) ? 0 : 1].correct = true;
    answerText = "";
  }

  // --- type ---
  let type;
  if (options.length >= 2) {
    const nc = options.filter(o => o.correct).length;
    type = nc > 1 || SATA_RE.test(title) ? "checkboxes" : "multiple_choice";
    if (!nc) warnings.push("No correct answer found. Mark it after importing.");
    if (type === "checkboxes" && nc === 1) warnings.push("Looks like “select all” but only one answer is marked.");
  } else {
    if (options.length === 1) { warnings.push("Only one option was detected; the rest may be on another line."); title += " " + options[0].text; options = []; }
    const alts = answerText.split("|").map(s => s.trim()).filter(Boolean);
    const tol = answerText.match(/^([-+]?\d+(?:\.\d+)?)\s*(?:±|\+\/-)\s*(\d+(?:\.\d+)?)$/);
    if (tol) { type = "number"; answerText = tol[1]; tolerance = +tol[2]; }
    else if (alts.length && alts.every(a => /^[-+]?\d+(?:\.\d+)?$/.test(a))) type = "number";
    else type = "text";
    if (!answerText) warnings.push("No answer found. Add the answer key after importing.");
  }

  const q = { id: "q_" + rnd(), title, type, points: pts, required: true };
  if (options.length) q.options = options.map(o => ({ id: "opt_" + rnd(), text: o.text, isCorrect: !!o.correct }));
  else q.answerText = answerText;
  if (tolerance) q.tolerance = tolerance;
  if (c.exp && c.exp.trim()) q.explanation = c.exp.replace(/\s+/g, " ").trim();
  return { q, src, warnings };
}

export function parseQuizText(raw, { points = 1 } = {}) {
  // 1) normalise into lines {t, b}
  const lines = [];
  for (let l of String(raw ?? "").replace(/\r/g, "").split("\n")) {
    l = l.replace(/[\u00a0\u200b\ufeff]/g, " ").trim();
    if (!l) continue;
    if (/^(page\s*\d+(\s*(\/|of)\s*\d+)?|\d+\s+of\s+\d+)$/i.test(l)) continue; // page numbers
    let b = false;
    const m = l.match(/^\*\*(.+)\*\*$/);
    if (m) { b = true; l = m[1].trim(); }
    for (const t of splitInline(l)) lines.push({ t, b });
  }

  const numbered = lines.filter(x => qStart(x.t) && !OPT_RE.test(x.t)).length >= 2;
  const cands = [];                       // raw question candidates
  const keyL = new Map(), keyT = new Map();
  let cur = null, mode = "none", keyMode = false, docTitle = "";

  const start = (num, title) => { cur = { num, index: cands.length, title, options: [], ans: null, exp: "" }; cands.push(cur); mode = "title"; };

  for (const { t, b } of lines) {
    // answer-key section at the end
    if (keyMode) {
      const kp = keyPairs(t);
      if (kp.length) kp.forEach(([n, a]) => keyL.set(n, a));
      else { const m = t.match(/^(\d{1,3})\s*[.):\-=]\s*(.+)$/); if (m) keyT.set(+m[1], m[2]); }
      continue;
    }
    if (KEYHEAD_RE.test(t) && cands.length) { keyMode = true; continue; }
    const kl = cands.length && asKeyLine(t);
    if (kl) { kl.forEach(([n, a]) => keyL.set(n, a)); continue; }
    if (SECTION_RE.test(t) && t.length < 60) continue;

    let m;
    if (cur && (m = t.match(ANS_RE))) { cur.ans = m[1]; mode = "ans"; continue; }
    if (cur && (m = t.match(EXP_RE))) { cur.exp = m[1]; mode = "exp"; continue; }

    const qs = qStart(t);
    if (qs && !(cur && mode !== "title" && OPT_RE.test(t))) { start(qs.num, qs.rest); continue; }

    if (cur && (m = t.match(OPT_RE)) && mode !== "exp" && m[2].toUpperCase().charCodeAt(0) - 65 === cur.options.length) {
      let text = m[3], correct = !!m[1];
      if (CORRECT_TAIL.test(text)) { text = text.replace(CORRECT_TAIL, ""); correct = true; }
      cur.options.push({ text, correct, bold: b });
      mode = "opt"; continue;
    }
    if (cur && cur.title && mode !== "exp" && (m = t.match(BULLET_RE))) {
      let text = m[1], correct = false;
      if (CORRECT_TAIL.test(text)) { text = text.replace(CORRECT_TAIL, ""); correct = true; }
      cur.options.push({ text, correct, bold: b });
      mode = "opt"; continue;
    }

    // continuation / unnumbered question / preamble
    if (!cur) {
      if (numbered) { if (!docTitle && t.length <= 120) docTitle = t; }
      else start(null, t);
    } else if (mode === "exp") cur.exp += " " + t;
    else if (mode === "ans") { if (numbered) cur.ans += " " + t; else start(null, t); }
    else if (mode === "opt") {
      if (numbered || /^[a-z(]/.test(t)) cur.options[cur.options.length - 1].text += " " + t;
      else start(null, t);
    } else cur.title += " " + t;
  }

  // key sections map by printed number if they're unique, otherwise by order
  const nums = cands.map(c => c.num);
  const byNum = nums.every(n => n != null) && new Set(nums).size === nums.length;

  const items = cands.map(c => finalize(c, points, keyL, keyT, byNum)).filter(Boolean);
  return { items, docTitle: items.length ? docTitle : "" };
}
