// Escape for text AND attribute contexts (DOMPurify does not escape quotes).
export const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const norm = s => String(s ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/\s+/g, " ").trim();

// Single source of truth for scoring (used by student page AND teacher dashboard).
export function grade(questions, keys, answers, partial = false) {
  let total = 0, earned = 0, correct = 0;
  const per = {};
  for (const q of questions) {
    const k = keys[q.id] || {}, pts = q.points ?? 1, a = answers[q.id];
    total += pts;
    let c = 0;
    if (q.type === "multiple_choice" || q.type === "drop_list") {
      c = (k.correct || []).includes(a) ? 1 : 0;
    } else if (q.type === "checkboxes") {
      const ok = k.correct || [], u = Array.isArray(a) ? a : [];
      const hit = u.filter(x => ok.includes(x)).length, wrong = u.length - hit;
      if (ok.length && hit === ok.length && wrong === 0) c = 1;
      else if (partial && ok.length) c = Math.max(0, (hit - wrong) / ok.length);
    } else if (q.type === "number") {
      const u = parseFloat(a), tol = Number(q.tolerance) || 0;
      const alts = String(k.answerText || "").split("|").map(parseFloat).filter(n => !isNaN(n));
      c = !isNaN(u) && alts.some(n => Math.abs(n - u) <= tol + 1e-9) ? 1 : 0;
    } else {
      const u = norm(a);
      c = u && String(k.answerText || "").split("|").map(norm).includes(u) ? 1 : 0;
    }
    per[q.id] = c; earned += c * pts; if (c === 1) correct++;
  }
  return { total, earned, correct, per, pct: total > 0 ? Math.round(earned / total * 100) : 0 };
}

// CSV with formula-injection guard + UTF-8 BOM (Excel-friendly for non-ASCII names)
export function toCsv(rows) {
  const cell = v => { let s = String(v ?? ""); if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; return '"' + s.replace(/"/g, '""') + '"'; };
  return "\uFEFF" + rows.map(r => r.map(cell).join(",")).join("\r\n");
}
export function download(name, text) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
  a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

export function toast(msg, err = false) {
  const t = document.createElement("div");
  t.textContent = msg; t.setAttribute("role", "status");
  t.style.cssText = `position:fixed;left:50%;bottom:24px;transform:translateX(-50%);background:${err ? "#F87171" : "#34D399"};color:#0E1020;padding:10px 18px;border-radius:8px;font-weight:600;z-index:9999;max-width:90vw`;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), err ? 6000 : 2500);
}
