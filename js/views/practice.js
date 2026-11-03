import { CONFIDENCE, PACE_MS, answers as answerEvents, formatMs, pct } from "../core/analytics.js";
import { chunkNow, getChunk, manifest, moduleInfo, topicInfo } from "../core/data.js";
import { getEvents, logEvent } from "../core/events.js";
import { renderMath } from "../core/katex.js";
import { href } from "../core/router.js";
import { buildModel } from "../core/mastery.js";
import { settingsFrom } from "../core/settings.js";
import { pickItemSet, pickQuestions, questionMeta, questionPool } from "../core/select.js";
import { planSession, resolveSession } from "../core/smart.js";
import { html, useEffect, useRef, useState } from "../lib.js";
import { ErrorBox, Loading, Md, useAsync } from "../ui.js";

const DRILL_SIZE = 10;
const LETTERS = ["A", "B", "C"];
const paragraphs = (text) => (text ?? "").split(/\n{2,}/).filter(Boolean);

function useTopicData(topicId) {
  return useAsync(async () => {
    const [chunk, events] = await Promise.all([chunkNow(topicId) ?? getChunk(topicId), getEvents()]);
    return { chunk, events };
  }, [topicId]);
}

// ---------------------------------------------------------------- home

export function PracticeHome() {
  const topics = [...manifest().topics].sort((a, b) => b.weight - a.weight);
  return html`<div class="stack">
    <h1>Practice</h1>
    <section class="card stack smart-entry">
      <strong>Smart Session</strong>
      <p class="small muted">About 60% your highest-priority weak points (weighted by exam importance), 25% reviews
        that are due, 15% upkeep of strong areas. Each question shows why it was picked.</p>
      <div class="row">${[15, 30, 60].map((m) => html`<a class=${`btn ${m === 30 ? "primary" : ""}`} href=${href("practice", "smart", String(m))}>${m} min</a>`)}</div>
    </section>
    <section class="card spread">
      <div><strong>Mock exam</strong><div class="small muted">Timed, Level II format, all topics by exam weight</div></div>
      <a class="btn" href="#/practice/mock">Open</a>
    </section>
    <h2 class="section-title">By topic</h2>
    <p class="muted small">Drills show unseen questions first, then ones you got wrong. Every answer is saved on this device.</p>
    ${topics.map((t) => html`<section class="card stack">
      <div class="spread"><strong>${t.name}</strong><span class="chip accent">${(t.weight * 100).toFixed(1)}%</span></div>
      <div class="row">
        <a class="btn" href=${href("practice", "drill", t.id)} aria-disabled=${!t.counts.questions}>Drill (${t.counts.questions})</a>
        <a class="btn" href=${href("practice", "set", t.id)} aria-disabled=${!t.counts.item_sets}>Item sets (${t.counts.item_sets})</a>
        <a class="btn" href=${href("practice", "cards", t.id)} aria-disabled=${!t.counts.formulas}>Formula cards (${t.counts.formulas})</a>
      </div>
    </section>`)}
  </div>`;
}

// ---------------------------------------------------------------- question card

export function Options({ q, chunk, value, onChange, reveal }) {
  return html`<div class="options" role="radiogroup" aria-label="Answer options">
    ${q.options.map((opt, i) => {
      const letter = LETTERS[i];
      const state = !reveal ? "" : letter === q.answer ? "right" : letter === value.choice ? "wrong" : "";
      return html`<button class=${`option ${state}`} role="radio" aria-checked=${value.choice === letter} disabled=${reveal}
          onClick=${() => onChange({ ...value, choice: letter })}>
        <span class="letter">${letter}</span><${Md} text=${opt} chunk=${chunk} />
      </button>`;
    })}
  </div>`;
}

function Confidence({ value, onChange, disabled }) {
  return html`<div class="confidence">
    <span class="small muted">How sure are you?</span>
    <div class="seg" role="group" aria-label="Confidence">
      ${[1, 2, 3].map((c) => html`<button aria-pressed=${value.conf === c} disabled=${disabled}
        onClick=${() => onChange({ ...value, conf: c })}>${CONFIDENCE[c]}</button>`)}
    </div>
  </div>`;
}

function Feedback({ q, chunk, choice, ms }) {
  const correct = choice === q.answer;
  const { module } = questionMeta(q, chunk);
  const info = module && moduleInfo(module);
  const prereqs = (chunk.learning[module]?.connections ?? []).filter((c) => c.type === "requires");
  return html`<div class=${`feedback ${correct ? "ok" : "bad"}`} role="status">
    <div class="spread"><strong>${correct ? "✓ Correct" : `✗ Incorrect: the answer is ${q.answer}`}</strong>
      ${ms != null ? html`<span class="small">${formatMs(ms)} ${ms > PACE_MS ? "· over 3:00 pace" : ""}</span>` : null}</div>
    ${q.explanations
      ? html`<ul class="why-list">${LETTERS.map((l) => html`<li class=${l === q.answer ? "right" : ""}><b>${l}.</b> <${Md} text=${q.explanations[l]} chunk=${chunk} /></li>`)}</ul>`
      : html`<div class="why-list"><${Md} tag="p" text=${q.explanation} chunk=${chunk} /></div>`}
    ${!correct && info ? html`<div class="go-deeper">
      <span class="small muted">Go deeper</span>
      <a href=${href("m", module)}>Logic chain and reading: ${info.module.title}</a>
      ${prereqs.map((c) => moduleInfo(c.to) && html`<a href=${href("m", c.to)}>Builds on: ${moduleInfo(c.to).module.title}</a>`)}
      ${prereqs.length ? html`<a href=${href("map", module)}>Trace prerequisites to the root gap on the concept map</a>` : null}
    </div>` : null}
    <${ReportProblem} q=${q} module=${module} />
  </div>`;
}

/** Log a "flag" event so wrong keys or unclear questions can be listed (Analytics) and fixed. */
function ReportProblem({ q, module }) {
  const [note, setNote] = useState("");
  const [sent, setSent] = useState(false);
  if (sent) return html`<p class="small muted">Reported ✓ It's listed under Analytics → Reported questions.</p>`;
  const send = async () => {
    await logEvent("flag", { qid: q.id, module: module ?? null, note: note.trim() });
    setSent(true);
  };
  return html`<details class="small report">
    <summary>Report a problem with this question</summary>
    <textarea rows="2" placeholder="e.g. the key should be B because…" value=${note} onInput=${(e) => setNote(e.target.value)}></textarea>
    <div><button class="btn" onClick=${send}>Report</button></div>
  </details>`;
}

export function QuestionCard({ q, chunk, value, onChange, reveal, label, ms }) {
  const ref = useRef(null);
  const { los } = questionMeta(q, chunk);
  useEffect(() => { renderMath(ref.current); }, [q.id, reveal]);
  return html`<article class="qcard" ref=${ref}>
    <div class="small muted">${label} · ${los.map((l) => l.replace(/^los\.0?/, "LOS ")).join(", ")}
      ${q.source === "schweser" ? " · Schweser module quiz" : ` · ${q.qtype}`}</div>
    ${q.vignette ? html`<details class="vignette" open>
      <summary>Case information</summary>${paragraphs(q.vignette).map((p) => html`<${Md} tag="p" text=${p} chunk=${chunk} />`)}</details>` : null}
    <${Md} tag="p" text=${q.stem} chunk=${chunk} />
    <${Options} q=${q} chunk=${chunk} value=${value} onChange=${onChange} reveal=${reveal} />
    <${Confidence} value=${value} onChange=${onChange} disabled=${reveal} />
    ${reveal ? html`<${Feedback} q=${q} chunk=${chunk} choice=${value.choice} ms=${ms} />` : null}
  </article>`;
}

export async function recordAnswer(q, chunk, topic, value, ms, mode, extra = {}) {
  const { los, module } = questionMeta(q, chunk);
  await logEvent("answer", {
    qid: q.id, los, topic, module, correct: value.choice === q.answer, ms: Math.round(ms),
    confidence: value.conf, mode, choice: value.choice, ...extra,
  });
}

// ---------------------------------------------------------------- session runner (drill + smart)

/**
 * Laptop shortcuts: handler(key) runs on every keydown outside text fields and returns false when
 * it didn't use the key. Re-registered each render so it always sees the current state.
 */
function useShortcuts(handler) {
  useEffect(() => {
    const onKey = (e) => {
      if (e.ctrlKey || e.metaKey || e.altKey || e.target.closest?.("input, textarea, select, summary, a")) return;
      if (handler(e.key) !== false) e.preventDefault();
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  });
}

/** Runs a queue of {q, chunk, topic, reason?, kind?} one question at a time. */
function Runner({ items, title, mode, again }) {
  const [i, setI] = useState(0);
  const [value, setValue] = useState({ choice: null, conf: null });
  const [revealed, setRevealed] = useState(false);
  const [results, setResults] = useState([]);
  const shownAt = useRef(Date.now());
  const shownItems = useRef(items);

  // Start over when "again" brings a new queue. Not on mount: the effect runs after the first
  // paint, and resetting then would wipe an answer picked in between.
  useEffect(() => {
    if (shownItems.current === items) return;
    shownItems.current = items;
    setI(0); setResults([]); setValue({ choice: null, conf: null }); setRevealed(false);
    shownAt.current = Date.now();
  }, [items]);

  if (!items.length) return html`<div class="stack"><h1>${title}</h1><p>No questions available yet for this selection.</p>
    <a class="btn" href="#/practice">Back to practice</a></div>`;
  if (i >= items.length) return html`<${Summary} results=${results} title=${title} again=${again} />`;

  const { q, chunk, topic, reason, kind } = items[i];
  const submit = async () => {
    const ms = Date.now() - shownAt.current;
    setRevealed(true);
    setResults((r) => [...r, { q, correct: value.choice === q.answer, ms, conf: value.conf }]);
    await recordAnswer(q, chunk, topic, value, ms, mode, kind ? { smart: kind } : {});
  };
  const next = () => {
    setI(i + 1); setValue({ choice: null, conf: null }); setRevealed(false);
    shownAt.current = Date.now();
    window.scrollTo(0, 0);
  };
  useShortcuts((key) => {
    if (!revealed && LETTERS.includes(key.toUpperCase())) setValue((v) => ({ ...v, choice: key.toUpperCase() }));
    else if (!revealed && ["1", "2", "3"].includes(key)) setValue((v) => ({ ...v, conf: Number(key) }));
    else if (key === "Enter" && revealed) next();
    else if (key === "Enter" && value.choice && value.conf) submit();
    else return false;
  });
  return html`<div class="stack">
    <div class="spread"><h1 class="h-small">${title}</h1><span class="chip">${i + 1} / ${items.length}</span></div>
    <p class="small muted kbd-hint">Keys: A/B/C answer · 1/2/3 confidence · Enter submit or next</p>
    <div class="progress"><span style=${`width:${(100 * i) / items.length}%`}></span></div>
    ${reason ? html`<p class="reason small"><span class=${`chip ${kind}`}>${reason.split(": ")[0]}</span> ${reason.split(": ").slice(1).join(": ")}</p>` : null}
    <${QuestionCard} key=${q.id} q=${q} chunk=${chunk} value=${value} onChange=${setValue}
      reveal=${revealed} label=${`Question ${i + 1}`} ms=${results[i]?.ms} />
    <div class="row sticky-actions">
      ${!revealed
        ? html`<button class="btn primary" disabled=${!value.choice || !value.conf} onClick=${submit}>
            ${!value.choice ? "Choose an answer" : !value.conf ? "Rate your confidence" : "Submit"}</button>`
        : html`<button class="btn primary" onClick=${next}>${i + 1 < items.length ? "Next question" : "See summary"}</button>`}
    </div>
  </div>`;
}

export function Drill({ topic, module }) {
  const { value: data, error } = useTopicData(topic);
  const [run, setRun] = useState(0);
  const [items, setItems] = useState(null);
  useEffect(() => {
    if (!data) return;
    const picked = pickQuestions(questionPool(data.chunk, module), answerEvents(data.events), DRILL_SIZE);
    setItems(picked.map((q) => ({ q, chunk: data.chunk, topic })));
  }, [data, module, run]);
  if (error) return html`<${ErrorBox} error=${error} />`;
  if (!data || !items) return html`<${Loading} />`;
  const title = module ? moduleInfo(module)?.module.title : topicInfo(topic)?.name;
  return html`<${Runner} items=${items} title=${title} mode="drill" again=${() => setRun((n) => n + 1)} />`;
}

export function SmartSession({ minutes }) {
  const [run, setRun] = useState(0);
  const { value: items, error } = useAsync(async () => {
    const events = await getEvents();
    const model = buildModel(events, manifest(), Date.now(), { target: settingsFrom(events).target ?? undefined });
    const intents = planSession(model, manifest(), events, Number(minutes) || 30);
    return resolveSession(intents, events, getChunk);
  }, [minutes, run]);
  if (error) return html`<${ErrorBox} error=${error} />`;
  if (!items) return html`<${Loading} label="Planning your session…" />`;
  return html`<${Runner} items=${items} title=${`Smart Session · ${minutes} min`} mode="smart" again=${() => setRun((n) => n + 1)} />`;
}

function Summary({ results, title, again }) {
  const right = results.filter((r) => r.correct).length;
  const avg = results.reduce((s, r) => s + r.ms, 0) / Math.max(results.length, 1);
  const sureWrong = results.filter((r) => !r.correct && r.conf === 3).length;
  const missed = results.filter((r) => !r.correct);
  return html`<div class="stack">
    <h1>${title}: session done</h1>
    <div class="tiles">
      <div class="tile"><div class="k">Score</div><div class="v">${right} / ${results.length}</div><div class="sub">${pct(right / results.length)}</div></div>
      <div class="tile"><div class="k">Avg time</div><div class="v">${formatMs(avg)}</div><div class="sub">pace 3:00</div></div>
      <div class="tile"><div class="k">Sure but wrong</div><div class="v">${sureWrong}</div><div class="sub">the dangerous ones</div></div>
    </div>
    ${missed.length ? html`<section class="card"><strong>Missed</strong><ul class="plain">${missed.map((r) => html`<li>
      <${Md} text=${r.q.stem.length > 110 ? r.q.stem.slice(0, 110) + "…" : r.q.stem} /></li>`)}</ul></section>` : null}
    <div class="row"><button class="btn primary" onClick=${again}>Another round</button>
      <a class="btn" href="#/practice">Back to practice</a><a class="btn" href="#/stats">See analytics</a></div>
  </div>`;
}

// ---------------------------------------------------------------- item sets

export function ItemSet({ topic }) {
  const { value: data, error } = useTopicData(topic);
  const [run, setRun] = useState(0);
  const [set, setSet] = useState(null);
  const [values, setValues] = useState([]);
  const [done, setDone] = useState(null); // {ms}
  const startedAt = useRef(Date.now());
  const root = useRef(null);

  useEffect(() => {
    if (!data) return;
    const picked = pickItemSet(data.chunk.item_sets, answerEvents(data.events));
    setSet(picked);
    setValues((picked?.questions ?? []).map(() => ({ choice: null, conf: null })));
    setDone(null);
    startedAt.current = Date.now();
    window.scrollTo(0, 0);
  }, [data, run]);
  useEffect(() => { renderMath(root.current); }, [set]);

  if (error) return html`<${ErrorBox} error=${error} />`;
  if (!data) return html`<${Loading} />`;
  if (!set) return html`<div class="stack"><h1>${topicInfo(topic)?.name}</h1><p>No item sets for this topic yet.</p>
    <a class="btn" href="#/practice">Back to practice</a></div>`;

  const complete = values.every((v) => v.choice && v.conf);
  const submit = async () => {
    const ms = Date.now() - startedAt.current;
    setDone({ ms });
    for (const [k, q] of set.questions.entries()) {
      await recordAnswer(q, data.chunk, topic, values[k], ms / set.questions.length, "item_set", { set: set.id });
    }
  };
  const score = done ? set.questions.filter((q, k) => values[k].choice === q.answer).length : 0;
  const pace = PACE_MS * set.questions.length;

  return html`<div class="stack" ref=${root}>
    <div class="spread"><h1 class="h-small">${set.title ?? "Item set"}</h1><span class="chip">${topicInfo(topic)?.name}</span></div>
    <section class="vignette-full">${paragraphs(set.vignette).map((p) => html`<${Md} tag="p" text=${p} chunk=${data.chunk} />`)}
      ${(set.exhibits ?? []).map((ex) => html`<div class="exhibit"><div class="small"><strong><${Md} text=${ex.title} /></strong></div>
        <div class="table-wrap"><table><thead><tr>${ex.rows[0].map((c) => html`<th><${Md} text=${c} /></th>`)}</tr></thead>
        <tbody>${ex.rows.slice(1).map((r) => html`<tr>${r.map((c) => html`<td><${Md} text=${c} /></td>`)}</tr>`)}</tbody></table></div></div>`)}
    </section>
    ${set.questions.map((q, k) => html`<${QuestionCard} key=${q.id} q=${q} chunk=${data.chunk} value=${values[k]}
      onChange=${(v) => setValues((vals) => vals.map((old, j) => (j === k ? v : old)))} reveal=${!!done} label=${`Question ${k + 1} of ${set.questions.length}`} />`)}
    ${done ? html`<div class="card spread"><strong>${score} / ${set.questions.length} correct</strong>
        <span class="small">${formatMs(done.ms)} ${done.ms > pace ? `· over the ${formatMs(pace)} pace` : `· within the ${formatMs(pace)} pace`}</span></div>
      <div class="row"><button class="btn primary" onClick=${() => setRun((n) => n + 1)}>Next item set</button>
        <a class="btn" href="#/practice">Back to practice</a></div>`
      : html`<div class="row sticky-actions"><button class="btn primary" disabled=${!complete} onClick=${submit}>
          ${complete ? "Submit item set" : `Answer all ${set.questions.length} questions (with confidence)`}</button></div>`}
  </div>`;
}

// ---------------------------------------------------------------- formula cards

const GRADES = [[1, "Again"], [2, "Hard"], [3, "Good"], [4, "Easy"]];

export function Cards({ topic }) {
  const { value: data, error } = useTopicData(topic);
  const [i, setI] = useState(0);
  const [shown, setShown] = useState(false);
  const [order, setOrder] = useState(null);
  const shownAt = useRef(Date.now());
  const root = useRef(null);

  useEffect(() => {
    if (!data) return;
    const reviewed = new Map();
    for (const e of data.events) if (e.type === "review") reviewed.set(e.payload.card, e.ts);
    setOrder([...data.chunk.formulas].sort((a, b) => (reviewed.get(a.id) ?? 0) - (reviewed.get(b.id) ?? 0)));
  }, [data]);
  useEffect(() => { renderMath(root.current); }, [i, shown, order]);

  if (error) return html`<${ErrorBox} error=${error} />`;
  if (!data || !order) return html`<${Loading} />`;
  if (!order.length) return html`<div class="stack"><h1>${topicInfo(topic)?.name}</h1><p>No formula cards for this topic yet.</p></div>`;
  const f = order[i % order.length];
  const grade = async (g) => {
    await logEvent("review", { card: f.id, topic, los: f.los, grade: g, ms: Date.now() - shownAt.current });
    setShown(false); setI(i + 1); shownAt.current = Date.now();
  };
  return html`<div class="stack" ref=${root}>
    <div class="spread"><h1 class="h-small">Formula cards</h1><span class="chip">${(i % order.length) + 1} / ${order.length}</span></div>
    <article class="card flashcard">
      <div class="small muted">${f.los.map((l) => l.replace(/^los\.0?/, "LOS ")).join(", ")}</div>
      <h2 class="h-small"><${Md} text=${f.name} /></h2>
      <p><strong>When to use.</strong> <${Md} text=${f.when_to_use} /></p>
      ${shown ? html`<div class="tex" data-display="1" data-tex=${f.latex}></div>
        <ul class="small">${f.variables.map((v) => html`<li><span class="tex" data-tex=${v.sym}></span>: <${Md} text=${v.def} /></li>`)}</ul>
        <p class="small"><strong>Intuition.</strong> <${Md} text=${f.intuition} /></p>
        <p class="small"><strong>Common mistake.</strong> <${Md} text=${f.common_mistake} /></p>`
      : html`<p class="muted small">Write or say the formula, then reveal it.</p>`}
    </article>
    <div class="row sticky-actions">
      ${shown ? GRADES.map(([g, label]) => html`<button class=${`btn ${g === 3 ? "primary" : ""}`} onClick=${() => grade(g)}>${label}</button>`)
              : html`<button class="btn primary" onClick=${() => setShown(true)}>Show formula</button>`}
    </div>
  </div>`;
}
