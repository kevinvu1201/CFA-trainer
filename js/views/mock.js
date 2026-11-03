// Timed mock exam. State lives in IndexedDB (kv "mock") after every change, so a refresh or
// a closed tab resumes where you left off, with the clock still running.

import { PACE_MS, TARGET, formatDate, formatMs, pct } from "../core/analytics.js";
import { getChunk, manifest, topicInfo } from "../core/data.js";
import { logEvent, useEvents } from "../core/events.js";
import { renderMath } from "../core/katex.js";
import { MOCK, buildMock, itemSetsFor, scoreSession } from "../core/mock.js";
import { kvDel, kvGet, kvSet } from "../core/store.js";
import { html, useEffect, useRef, useState } from "../lib.js";
import { ErrorBox, Loading, Md } from "../ui.js";
import { Options, QuestionCard, recordAnswer } from "./practice.js";

const paragraphs = (t) => (t ?? "").split(/\n{2,}/).filter(Boolean);

export function Mock() {
  const [state, setState] = useState(undefined); // undefined = loading, null = none
  const [chunks, setChunks] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => { kvGet("mock").then((s) => setState(s ?? null)); }, []);
  // Chunks are needed to resolve exhibits/figures; load the topics the mock uses.
  useEffect(() => {
    if (!state) return;
    const topics = [...new Set(state.sessions.flat().map((s) => s.topic))];
    Promise.all(topics.map((t) => getChunk(t).then((c) => [t, c]))).then((l) => setChunks(new Map(l))).catch(setError);
  }, [state?.id]);

  // Functional updates: several quick changes (e.g. answering in a burst) each apply to the
  // latest state instead of overwriting one another.
  const save = (next) => new Promise((resolve) => setState((prev) => {
    const value = typeof next === "function" ? next(prev) : next;
    resolve(value ? kvSet("mock", value) : kvDel("mock"));
    return value;
  }));

  if (error) return html`<${ErrorBox} error=${error} />`;
  if (state === undefined) return html`<${Loading} />`;
  if (!state) return html`<${MockStart} onStart=${save} />`;
  if (!chunks) return html`<${Loading} label="Loading the exam…" />`;
  if (state.phase === "results") return html`<${Results} state=${state} chunks=${chunks} onClose=${() => save(null)} />`;
  if (state.phase === "break") return html`<${Break} state=${state} onContinue=${() => save({ ...state, phase: "running", startedAt: Date.now(), active: 0 })} />`;
  return html`<${Running} state=${state} chunks=${chunks} save=${save} />`;
}

function MockStart({ onStart }) {
  const events = useEvents();
  const [busy, setBusy] = useState(null);
  const past = (events ?? []).filter((e) => e.type === "session" && e.payload.kind === "mock").reverse();
  const start = async (sessions) => {
    setBusy("Loading all topics…");
    const topics = manifest().topics;
    const setsByTopic = new Map();
    for (const t of topics) setsByTopic.set(t.id, itemSetsFor(await getChunk(t.id)));
    const { sessions: s, plan } = buildMock(setsByTopic, topics, { questions: (MOCK.questions / MOCK.sessions) * sessions, sessions });
    await onStart({ id: crypto.randomUUID(), created: Date.now(), sessions: s, plan, current: 0, phase: "running",
                    startedAt: Date.now(), active: 0, answers: {}, flags: {}, setMs: {}, results: [] });
  };
  return html`<div class="stack">
    <h1>Mock exam</h1>
    <p>Level II format: item sets of a case plus questions, drawn from every topic in proportion to its exam weight.
      Each session is timed at ${formatMs(MOCK.sessionMs).replace(/:00$/, "")} minutes (3 minutes per question). No confidence ratings,
      as in the real exam. Your answers are saved as you go, so you can close the app and resume.</p>
    <div class="row">
      <button class="btn primary" disabled=${!!busy} onClick=${() => start(2)}>Full mock · 2 × 2 h 12 min</button>
      <button class="btn" disabled=${!!busy} onClick=${() => start(1)}>Half mock · 1 session</button>
    </div>
    ${busy ? html`<p class="muted small" role="status">${busy}</p>` : null}
    ${past.length ? html`<h2 class="section-title">Past mocks</h2><ul class="list">${past.map((e) => html`<li><div class="item">
      <div class="grow">${formatDate(e.ts)} · ${e.payload.n} questions<div class="sub">time used ${formatMs(e.payload.ms)}</div></div>
      <span class=${`chip ${e.payload.acc >= TARGET ? "maintenance" : "review"}`}>${pct(e.payload.acc)}</span></div></li>`)}</ul>` : null}
  </div>`;
}

function Running({ state, chunks, save }) {
  const sets = state.sessions[state.current];
  const [, tick] = useState(0);
  const enteredAt = useRef(Date.now());
  const root = useRef(null);
  const deadline = state.startedAt + MOCK.sessionMs;
  const remaining = deadline - Date.now();
  const set = sets[state.active];

  useEffect(() => { const id = setInterval(() => tick((n) => n + 1), 1000); return () => clearInterval(id); }, []);
  useEffect(() => { renderMath(root.current); window.scrollTo(0, 0); enteredAt.current = Date.now(); }, [state.active, state.current]);
  useEffect(() => { if (remaining <= 0) submit(); }, [remaining <= 0]);

  // Time on the current set is banked whenever you move away from it.
  const bank = (s) => ({ ...s, setMs: { ...s.setMs, [set.id]: (s.setMs[set.id] ?? 0) + (Date.now() - enteredAt.current) } });
  const go = (i) => save((s) => ({ ...bank(s), active: i }));
  const answer = (qid, choice) => save((s) => ({ ...s, answers: { ...s.answers, [qid]: { choice } } }));
  const flag = (qid) => save((s) => ({ ...s, flags: { ...s.flags, [qid]: !s.flags[qid] } }));

  async function submit() {
    const s = bank(state);
    const score = scoreSession(sets, s.answers);
    const used = Math.min(Date.now() - s.startedAt, MOCK.sessionMs);
    for (const st of sets) {
      const chunk = chunks.get(st.topic);
      const per = (s.setMs[st.id] ?? 0) / st.questions.length;
      for (const q of st.questions) {
        if (!s.answers[q.id]) continue; // unanswered questions count as wrong in the score but aren't logged as attempts
        await recordAnswer(q, chunk, st.topic, { choice: s.answers[q.id].choice, conf: 2 }, per, "mock", { set: st.id, mock: s.id });
      }
    }
    const results = [...s.results, { ...score, ms: used }];
    const last = s.current + 1 >= s.sessions.length;
    if (last) {
      const n = results.reduce((x, r) => x + r.n, 0);
      const correct = results.reduce((x, r) => x + r.correct, 0);
      await logEvent("session", { kind: "mock", id: s.id, n, correct, acc: correct / Math.max(n, 1),
        ms: results.reduce((x, r) => x + r.ms, 0), sessions: results.length });
    }
    await save({ ...s, results, phase: last ? "results" : "break", current: last ? s.current : s.current + 1 });
  }

  const answered = (st) => st.questions.every((q) => state.answers[q.id]);
  const chunk = chunks.get(set.topic);
  const totalQ = sets.reduce((x, st) => x + st.questions.length, 0);
  const doneQ = sets.reduce((x, st) => x + st.questions.filter((q) => state.answers[q.id]).length, 0);
  return html`<div class="stack" ref=${root}>
    <div class="mock-bar">
      <strong class=${remaining < 10 * 60_000 ? "late" : ""}>${formatMs(Math.max(remaining, 0))}</strong>
      <span class="small muted">Session ${state.current + 1} of ${state.sessions.length} · ${doneQ}/${totalQ} answered</span>
      <button class="btn" onClick=${() => { if (confirm(`Submit session ${state.current + 1}? ${totalQ - doneQ} questions unanswered.`)) submit(); }}>Submit</button>
    </div>
    <nav class="mock-nav" aria-label="Item sets">${sets.map((st, i) => html`<button aria-current=${i === state.active ? "step" : undefined}
      class=${`${answered(st) ? "done" : ""} ${st.questions.some((q) => state.flags[q.id]) ? "flagged" : ""}`} onClick=${() => go(i)}>${i + 1}</button>`)}</nav>
    <div class="spread"><h1 class="h-small">Item set ${state.active + 1}</h1><span class="chip">${topicInfo(set.topic)?.name}</span></div>
    <section class="vignette-full">${paragraphs(set.vignette).map((p) => html`<${Md} tag="p" text=${p} chunk=${chunk} />`)}
      ${set.exhibits.map((ex) => html`<div class="exhibit"><div class="small"><strong><${Md} text=${ex.title} /></strong></div>
        <div class="table-wrap"><table><thead><tr>${ex.rows[0].map((c) => html`<th><${Md} text=${c} /></th>`)}</tr></thead>
        <tbody>${ex.rows.slice(1).map((r) => html`<tr>${r.map((c) => html`<td><${Md} text=${c} /></td>`)}</tr>`)}</tbody></table></div></div>`)}
    </section>
    ${set.questions.map((q, k) => html`<article class="qcard">
      <div class="spread small muted"><span>Question ${k + 1} of ${set.questions.length}</span>
        <button class=${`btn flag ${state.flags[q.id] ? "on" : ""}`} onClick=${() => flag(q.id)} aria-pressed=${!!state.flags[q.id]}>⚑ Flag</button></div>
      <${Md} tag="p" text=${q.stem} chunk=${chunk} />
      <${Options} q=${q} chunk=${chunk} value=${{ choice: state.answers[q.id]?.choice ?? null }} onChange=${(v) => answer(q.id, v.choice)} reveal=${false} />
    </article>`)}
    <div class="row sticky-actions">
      <button class="btn" disabled=${state.active === 0} onClick=${() => go(state.active - 1)}>‹ Previous set</button>
      ${state.active + 1 < sets.length ? html`<button class="btn primary" onClick=${() => go(state.active + 1)}>Next set ›</button>`
        : html`<button class="btn primary" onClick=${() => { if (confirm("Submit this session?")) submit(); }}>Submit session</button>`}
    </div>
  </div>`;
}

function Break({ state, onContinue }) {
  const r = state.results.at(-1);
  return html`<div class="stack">
    <h1>Session ${state.current} complete</h1>
    <p>${r.correct} / ${r.n} correct (${pct(r.acc)}) in ${formatMs(r.ms)}. Take a break; session ${state.current + 1}'s clock starts when you continue.</p>
    <button class="btn primary" onClick=${onContinue}>Start session ${state.current + 1}</button>
  </div>`;
}

function Results({ state, chunks, onClose }) {
  const all = state.sessions.slice(0, state.results.length).flat();
  const score = scoreSession(all, state.answers);
  const used = state.results.reduce((x, r) => x + r.ms, 0);
  const weights = new Map(manifest().topics.map((t) => [t.id, t]));
  const short = state.plan.filter((p) => p.got < p.target);
  return html`<div class="stack">
    <h1>Mock results</h1>
    <div class="tiles">
      <div class="tile"><div class="k">Score</div><div class="v">${pct(score.acc)}</div><div class="sub">${score.correct}/${score.n} · target ${pct(TARGET)}</div></div>
      <div class="tile"><div class="k">Time used</div><div class="v">${formatMs(used)}</div><div class="sub">pace ${formatMs(PACE_MS * score.n)}</div></div>
    </div>
    <div class="table-wrap card"><table><thead><tr><th>Topic</th><th class="n">Weight</th><th class="n">Questions</th><th class="n">Correct</th></tr></thead>
      <tbody>${score.perTopic.sort((a, b) => weights.get(b.topic).weight - weights.get(a.topic).weight).map((t) => html`<tr>
        <td>${weights.get(t.topic).name}</td><td class="n">${pct(weights.get(t.topic).weight, 1)}</td><td class="n">${t.n}</td>
        <td class="n">${pct(t.correct / t.n)}</td></tr>`)}</tbody></table></div>
    ${short.length ? html`<p class="small muted">Fewer questions than the exam weight implies for: ${short.map((p) => `${weights.get(p.topic).name} (${p.got} of ${p.target})`).join(", ")}.
      More item sets will appear as study content is generated for those topics.</p>` : null}
    <details class="card"><summary>Review every question</summary>
      ${all.map((st) => st.questions.map((q, k) => html`<${QuestionCard} key=${q.id} q=${{ ...q, vignette: k === 0 ? st.vignette : null }} chunk=${chunks.get(st.topic)}
        value=${{ choice: state.answers[q.id]?.choice ?? null, conf: null }} onChange=${() => {}} reveal=${true} label=${`${topicInfo(st.topic)?.name}`} />`))}
    </details>
    <button class="btn primary" onClick=${onClose}>Done</button>
  </div>`;
}
