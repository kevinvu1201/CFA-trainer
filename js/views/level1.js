// Level I: two mock exams in the real format (two sessions of 90 questions, 2 h 15 min each) and
// quick practice over the whole question pool, all from the curriculum practice problems. A mock
// session in progress lives in kv (resumable; exiting pauses its clock); finished sessions,
// practice answers and flags are events, so they sync. Every wrong answer points to the learning
// module to study.

import { formatDate, localDay, pct } from "../core/analytics.js";
import { getLevel1 } from "../core/data.js";
import { logEvent, useEvents } from "../core/events.js";
import {
  BETS, betRecord, boostLeft, comboOf, dailyCounts, dueComeback, flaggedSet, goalStreak, nextQuestion, openChest, pendingChests,
  personalBests, practiceState, sessionAnswers, settleAnswer, topicProgress, weekDots, xpBalance,
} from "../core/l1practice.js";
import { LevelSwitch } from "../core/level.js";
import { href } from "../core/router.js";
import { settingsFrom } from "../core/settings.js";
import { kvDel, kvGet, kvSet } from "../core/store.js";
import { html, useEffect, useMemo, useState } from "../lib.js";
import { ErrorBox, Loading, useAsync } from "../ui.js";

const LETTERS = ["A", "B", "C"];
const GUIDE = 0.7; // CFA Institute doesn't publish the pass mark; 70% is a common rule of thumb
const stateKey = (mock, n) => `l1:${mock}:${n}`;

/** 8100000 -> "2:15:00" */
function clock(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 3600)}:${String(Math.floor(s / 60) % 60).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

/** Latest finished attempt per session, keyed "mockId:n". */
function latestAttempts(events) {
  const out = new Map();
  for (const e of events ?? []) if (e.type === "l1session") out.set(`${e.payload.mock}:${e.payload.session}`, e);
  return out;
}

/** Wrong answers grouped by topic and learning module, most-missed first. */
function studyList(data, attemptList) {
  const groups = new Map();
  for (const e of attemptList) {
    for (const [qid, choice] of Object.entries(e.payload.answers)) {
      const q = data.questions[qid];
      if (!q || choice === q.answer) continue;
      const key = `${q.topic}:${q.lm}`;
      const g = groups.get(key) ?? { topic: q.topic, lm: q.lm, title: q.lm_title, volume: q.volume, page: q.page, wrong: 0 };
      g.wrong += 1;
      groups.set(key, g);
    }
  }
  return [...groups.values()].sort((a, b) => b.wrong - a.wrong || a.topic.localeCompare(b.topic) || a.lm - b.lm);
}

function Text({ blocks }) {
  return blocks.map((b) => (b.t === "table"
    ? html`<div class="table-wrap"><table>
        <thead><tr>${b.rows[0].map((c) => html`<th>${c}</th>`)}</tr></thead>
        <tbody>${b.rows.slice(1).map((r) => html`<tr>${r.map((c) => html`<td>${c}</td>`)}</tr>`)}</tbody></table></div>`
    : html`<p class=${/^Exhibit \d/.test(b.text) ? "small" : ""}>${/^Exhibit \d/.test(b.text) ? html`<strong>${b.text}</strong>` : b.text}</p>`));
}

function StudyPointer({ q, data }) {
  return html`<div class="study-pointer">
    <span class="small muted">Study</span>
    <strong>${data.topics[q.topic]} › Learning Module ${q.lm}: ${q.lm_title}</strong>
    <span class="small muted">CFA Program Curriculum 2026, Level I Volume ${q.volume}${q.page ? `, practice problems from p. ${q.page}` : ""}</span>
  </div>`;
}

function FlagButton({ qid, flagged }) {
  const on = flagged.has(qid);
  return html`<button class=${`btn flag ${on ? "on" : ""}`} aria-pressed=${on}
    onClick=${() => logEvent("l1flag", { qid, flagged: !on })}>⚑ ${on ? "Flagged" : "Flag"}</button>`;
}

/** A question with the correct answer marked, the explanation and (if missed) where to study. */
function ReviewCard({ q, qid, data, choice, label, flagged, collapsed }) {
  const right = choice === q.answer;
  const body = html`
    ${q.context.length ? html`<details class="vignette"><summary>Case information</summary><${Text} blocks=${q.context} /></details>` : null}
    <${Text} blocks=${q.stem} />
    <div class="options">${q.options.map((opt, k) => html`<div class=${`option ${LETTERS[k] === q.answer ? "right" : LETTERS[k] === choice ? "wrong" : ""}`}>
      <span class="letter">${LETTERS[k]}</span><span>${opt}</span></div>`)}</div>
    <div class=${`feedback ${right ? "ok" : "bad"}`}>
      <strong>${q.answer} is correct.</strong> <${Text} blocks=${q.explanation} />
      ${right ? null : html`<${StudyPointer} q=${q} data=${data} />`}
    </div>`;
  return html`<article class="qcard">
    <div class="spread small muted"><span>${label} · ${data.topics[q.topic]}</span>
      <span class="row">${flagged ? html`<${FlagButton} qid=${qid} flagged=${flagged} />` : null}
        <span class=${`chip ${right ? "maintenance" : "review"}`}>${right ? "Correct" : choice ? `You chose ${choice}` : "Skipped"}</span></span></div>
    ${collapsed ? html`<details><summary>${q.stem.find((b) => b.t === "p")?.text.slice(0, 90) ?? "Question"}…</summary>${body}</details>` : body}
  </article>`;
}

const topicsOf = (data, session) => session.plan.map((p) => data.topics[p.topic]).join(", ");

// ---------------------------------------------------------------- home

export function L1Home() {
  const { value: data, error } = useAsync(getLevel1, []);
  const events = useEvents();
  const { value: open } = useAsync(async () => {
    if (!data) return null;
    const pairs = await Promise.all(data.mocks.flatMap((m) => m.sessions.map(async (s) => [`${m.id}:${s.n}`, await kvGet(stateKey(m.id, s.n))])));
    return new Map(pairs.filter(([, v]) => v));
  }, [data]);
  if (error) return html`<${ErrorBox} error=${error} />`;
  if (!data || !events) return html`<${Loading} />`;
  const done = latestAttempts(events);

  const start = async (mock, n) => {
    if (done.has(`${mock}:${n}`) && !confirm("Retake this session? Your previous result stays in the history.")) return;
    await kvSet(stateKey(mock, n), { startedAt: Date.now(), answers: {}, flags: {}, active: 0 });
    location.hash = href("l1", mock, String(n));
  };
  const restart = async (mock, n) => {
    if (!confirm("Start this session over? Your answers so far are cleared and the clock restarts at 2:15:00.")) return;
    await kvSet(stateKey(mock, n), { startedAt: Date.now(), answers: {}, flags: {}, active: 0 });
    location.hash = href("l1", mock, String(n));
  };
  const study = studyList(data, [...done.values()]);

  return html`<div class="stack">
    <div class="spread"><h1>CFA Level I</h1><${LevelSwitch} level=${1} /></div>

    <${PracticeCard} data=${data} events=${events} />

    <p class="small muted">Two full mock exams in the real format: two sessions of 90 questions, 2 h 15 min each, topics in exam order
      and weight. Answers save as you go; exiting pauses the clock until you resume.</p>
    ${data.mocks.map((m) => html`<section class="card stack">
      <strong>${m.title}</strong>
      ${m.sessions.map((s) => {
        const key = `${m.id}:${s.n}`;
        const last = done.get(key);
        const live = open?.get(key);
        const left = live ? live.startedAt + s.minutes * 60_000 - (live.pausedAt ?? Date.now()) : 0;
        return html`<div class="l1-session">
          <div class="grow"><div>Session ${s.n} · ${s.questions.length} questions · 2 h 15 min</div>
            <div class="small muted">${topicsOf(data, s)}</div>
            ${last ? html`<div class="small">Score <strong>${pct(last.payload.correct / last.payload.n)}</strong> (${last.payload.correct}/${last.payload.n})
              · ${formatDate(last.ts)}</div>` : null}
            ${live ? html`<div class="small" style="color:var(--warn)">${live.pausedAt ? "Paused" : "In progress"} · ${Object.keys(live.answers).length}/${s.questions.length} answered
              · ${left > 0 ? `${clock(left)} left` : "time is up"}</div>` : null}</div>
          <div class="row">
            ${live ? html`<a class="btn primary" href=${href("l1", m.id, String(s.n))}>Resume</a>
                <button class="btn" onClick=${() => restart(m.id, s.n)}>Start over</button>`
              : html`<button class=${`btn ${last ? "" : "primary"}`} onClick=${() => start(m.id, s.n)}>${last ? "Retake" : "Start"}</button>`}
            ${last ? html`<a class="btn" href=${href("l1", m.id, String(s.n), "review")}>Review</a>` : null}
          </div>
        </div>`;
      })}
    </section>`)}

    <h2 class="section-title">What to study (mocks)</h2>
    ${study.length ? html`<p class="small muted">Learning modules behind your wrong mock answers (latest attempt of each session), most missed first.</p>
      <ul class="list">${study.map((g) => html`<li><div class="item"><div class="grow">
        <div>${data.topics[g.topic]} › LM ${g.lm}: ${g.title}</div>
        <div class="sub">Volume ${g.volume}${g.page ? `, practice problems from p. ${g.page}` : ""}</div></div>
        <span class="chip review">${g.wrong} wrong</span></div></li>`)}</ul>`
      : html`<p class="small muted">Finish a mock session to see which learning modules to review.</p>`}
  </div>`;
}

// ---------------------------------------------------------------- quick practice

const MODE_TITLE = { pool: "Quick practice", wrong: "Practice wrong answers", flagged: "Practice flagged questions" };
const TIER = { common: "Common", rare: "Rare", jackpot: "JACKPOT" };

function prizeText(p) {
  if (p.prize === "double") return "Double XP for your next 10 answers";
  if (p.prize === "freeze") return "Streak freeze: one missed day won't break your streak";
  return `+${p.xp} XP`;
}

/** Opens the next earned chest; shows what was inside. */
function ChestButton({ events }) {
  const [opened, setOpened] = useState(null);
  const pending = pendingChests(events);
  const open = async () => {
    const seed = pending[0];
    const prize = openChest(seed);
    await logEvent("l1reward", { kind: "chest", seed, ...prize });
    setOpened(prize);
  };
  if (opened) return html`<div class=${`chest-result ${opened.tier}`} role="status">
    <span class="small">${TIER[opened.tier]}</span><strong>${prizeText(opened)}</strong>
    ${pending.length ? html`<button class="btn" onClick=${() => setOpened(null)}>Next chest (${pending.length})</button>` : null}</div>`;
  if (!pending.length) return null;
  return html`<button class="btn chest" onClick=${open}>🎁 Open mystery chest${pending.length > 1 ? ` (${pending.length})` : ""}</button>`;
}

function GoalRing({ n, goal }) {
  const r = 26;
  const c = 2 * Math.PI * r;
  const frac = Math.min(n / goal, 1);
  return html`<svg class="goal-ring" viewBox="0 0 64 64" width="64" height="64" role="img" aria-label=${`${n} of ${goal} today`}>
    <circle cx="32" cy="32" r=${r} class="track" />
    <circle cx="32" cy="32" r=${r} class=${`fill ${frac >= 1 ? "done" : ""}`} stroke-dasharray=${`${c * frac} ${c}`} transform="rotate(-90 32 32)" />
    <text x="32" y="30" text-anchor="middle" class="n">${n}</text><text x="32" y="44" text-anchor="middle" class="of">/ ${goal}</text>
  </svg>`;
}

/** The Quick practice card on the Level I home: goal, streak, XP, chests, progress. */
function PracticeCard({ data, events }) {
  const s = settingsFrom(events);
  const goal = s.l1_daily_goal;
  const game = s.l1_game;
  const practice = practiceState(events, data.pool);
  const flagged = flaggedSet(events);
  const today = dailyCounts(events).get(localDay(Date.now())) ?? 0;
  const streak = goalStreak(events, goal);
  const week = weekDots(events, goal);
  const topics = topicProgress(events, data);
  const bests = personalBests(events);
  const bets = betRecord(events);
  return html`<section class="card stack">
    <div class="spread"><strong>Quick practice</strong><span class="chip">${data.pool.length} questions</span></div>
    <div class="practice-head">
      <${GoalRing} n=${today} goal=${goal} />
      <div class="grow">
        <div class="streak">${streak ? `🔥 ${streak}-day streak` : "Start a streak today"}</div>
        <div class="small muted">${today >= goal ? "Daily goal reached ✓" : `${goal - today} more today to ${streak ? "keep" : "start"} it`}</div>
        <div class="week-dots">${week.map((d) => html`<span class=${`dot ${d.met ? "met" : d.n ? "some" : ""} ${d.today ? "today" : ""}`}
          title=${`${d.n} answered`}>${d.label}</span>`)}</div>
      </div>
      ${game ? html`<div class="xp"><strong>${xpBalance(events)}</strong><span class="small muted">XP</span></div>` : null}
    </div>
    ${game ? html`<${ChestButton} events=${events} />` : null}
    <div class="progress"><span style=${`width:${(100 * practice.seen.size) / data.pool.length}%`}></span></div>
    <div class="small muted">Round ${practice.round}: ${practice.seen.size} of ${data.pool.length} answered, ${practice.remaining.length} to go
      ${practice.answers ? ` · ${pct(practice.correct / practice.answers)} correct overall` : ""}</div>
    <div class="row">
      <a class="btn primary" href=${href("l1", "practice", "pool")}>Start practice</a>
      <a class="btn" href=${href("l1", "list", "wrong")}>Wrong (${practice.wrong.length})</a>
      <a class="btn" href=${href("l1", "list", "flagged")}>Flagged (${flagged.size})</a>
    </div>
    <details><summary class="small">Progress by topic</summary>
      ${topics.map((t) => html`<div class="topic-bar">
        <div class="spread small"><span>${data.topics[t.topic]}</span>
          <span class="muted">${t.answered}/${t.total}${t.answered ? ` · ${pct(t.right / t.answered)}` : ""}</span></div>
        <div class="progress"><span style=${`width:${(100 * t.answered) / t.total}%`}></span></div></div>`)}
    </details>
    <details><summary class="small">Pool map</summary>
      <p class="small muted">Every question, grouped by topic: grey not yet answered, green right, red wrong, amber flagged.</p>
      <div class="pool-map">${data.pool.map((id) => {
        const a = practice.latest.get(id);
        return html`<i class=${`${a ? (a.correct ? "r" : "w") : ""} ${flagged.has(id) ? "f" : ""}`} />`;
      })}</div>
    </details>
    <details><summary class="small">Personal bests${game ? " and bets" : ""}</summary>
      <ul class="plain small">
        <li>Longest combo: <strong>${bests.bestCombo}</strong> correct in a row</li>
        <li>Most in a day: <strong>${bests.bestDay}</strong> questions</li>
        <li>Best session (10+ questions): <strong>${bests.bestAccuracy == null ? "—" : pct(bests.bestAccuracy)}</strong></li>
        ${game ? Object.entries(BETS).map(([k, b]) => html`<li>"${b.label}" bets: ${bets[k].n
          ? html`<strong>${pct(bets[k].right / bets[k].n)}</strong> right (${bets[k].n} bets)` : "none yet"}</li>`) : null}
      </ul>
      ${game ? html`<p class="small muted">If your "Sure" bets aren't right far more often than your "Guess" bets, you're overconfident; that's what
        the exam punishes.</p>` : null}
    </details>
  </section>`;
}

export function L1Practice({ mode }) {
  const { value: data, error } = useAsync(getLevel1, []);
  const events = useEvents();
  const [session] = useState(() => crypto.randomUUID());
  const [qid, setQid] = useState(undefined); // undefined: not picked yet; null: nothing left
  const [why, setWhy] = useState(null); // "comeback" | "review" | null
  const [pick, setPick] = useState(null); // selected option before betting
  const [choice, setChoice] = useState(null); // submitted answer
  const [result, setResult] = useState(null); // {payout, combo}
  const [ended, setEnded] = useState(false);
  const [limit, setLimit] = useState(null); // "5 more" target
  const [celebrate, setCelebrate] = useState(false);

  const flagged = useMemo(() => (events ? flaggedSet(events) : new Set()), [events?.length]);
  const answered = events ? sessionAnswers(events, session) : [];
  const settings = events ? settingsFrom(events) : null;
  const game = settings?.l1_game;

  const next = () => {
    if (limit !== null && sessionAnswers(events, session).length >= limit) { setLimit(null); setEnded(true); return; }
    const state = practiceState(events, data.pool);
    const done = sessionAnswers(events, session);
    const q = nextQuestion(mode, state, flagged, new Set(done.map((a) => a.qid)), Math.random, done);
    setWhy(q && q === dueComeback(done) ? "comeback" : q && mode === "pool" && state.wrong.includes(q) ? "review" : null);
    setQid(q);
    setPick(null); setChoice(null); setResult(null);
    window.scrollTo(0, 0);
  };
  useEffect(() => { if (data && events && qid === undefined) next(); }, [data, events !== null]);

  const answer = async (letter, conf) => {
    if (choice || !qid) return;
    const correct = letter === data.questions[qid].answer;
    const state = practiceState(events, data.pool);
    const combo = correct ? comboOf(answered) + 1 : 0;
    const payout = settleAnswer({ correct, conf: game ? conf : undefined, retry: state.wrong.includes(qid), combo, boost: boostLeft(events) > 0 });
    const before = dailyCounts(events).get(localDay(Date.now())) ?? 0;
    setChoice(letter);
    setResult({ payout, combo });
    await logEvent("l1practice", { qid, choice: letter, correct, session, mode, ...(game && conf ? { conf: Number(conf), stake: BETS[conf].stake } : {}), payout });
    if (before + 1 === settings.l1_daily_goal) setCelebrate(true);
  };
  const select = (letter) => (game ? setPick(letter) : answer(letter));

  useEffect(() => {
    if (!data || ended) return undefined;
    const onKey = (e) => {
      if (e.ctrlKey || e.metaKey || e.altKey || e.target.closest?.("input, textarea")) return;
      const k = e.key.toUpperCase();
      if (!choice && LETTERS.includes(k)) select(k);
      else if (!choice && pick && BETS[k]) answer(pick, k);
      else if (choice && e.key === "Enter") next();
      else if (k === "F" && qid) logEvent("l1flag", { qid, flagged: !flagged.has(qid) });
      else return;
      e.preventDefault();
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  });

  if (error) return html`<${ErrorBox} error=${error} />`;
  if (!data || !events || qid === undefined) return html`<${Loading} />`;
  const right = answered.filter((a) => a.correct).length;
  const sessionXp = answered.reduce((x, a) => x + (a.payout ?? 0), 0);
  const today = dailyCounts(events).get(localDay(Date.now())) ?? 0;
  const combo = comboOf(answered);

  if (ended || (!qid && answered.length)) {
    return html`<div class="stack">
      <h1>Session summary</h1>
      <div class="tiles">
        <div class="tile"><div class="k">Answered</div><div class="v">${answered.length}</div><div class="sub">${right} right · ${answered.length - right} wrong</div></div>
        <div class="tile"><div class="k">${game ? "XP" : "Correct"}</div><div class="v">${game ? `${sessionXp >= 0 ? "+" : ""}${sessionXp}` : answered.length ? pct(right / answered.length) : "—"}</div>
          <div class="sub">${game ? `${answered.length ? pct(right / answered.length) : "—"} correct` : "this session"}</div></div>
      </div>
      ${game ? html`<${ChestButton} events=${events} />` : null}
      ${!qid && !ended ? html`<p class="small muted">${mode === "pool" ? "You've answered the whole pool." : "Nothing left in this list."}</p>` : null}
      <div class="row">
        ${qid || mode === "pool" ? html`<button class="btn primary" onClick=${() => { setEnded(false); setLimit(answered.length + 5); next(); }}>5 more</button>` : null}
        ${answered.some((a) => !a.correct) && mode !== "wrong" ? html`<a class="btn" href=${href("l1", "practice", "wrong")}>Practice wrong answers</a>` : null}
        <a class="btn" href="#/">Finish</a>
      </div>
      ${answered.length ? html`<h2 class="section-title">This session</h2>
        ${answered.map((a, i) => html`<${ReviewCard} key=${i} qid=${a.qid} q=${data.questions[a.qid]} data=${data} choice=${a.choice}
          label=${`#${i + 1}`} flagged=${flagged} collapsed=${true} />`)}` : null}
    </div>`;
  }
  if (!qid) {
    return html`<div class="stack"><h1>${MODE_TITLE[mode]}</h1>
      <p class="muted">${mode === "wrong" ? "No wrong answers to practise. Nice." : mode === "flagged" ? "You haven't flagged any questions." : "No questions available."}</p>
      <a class="btn" href="#/">Back to Level I</a></div>`;
  }

  const q = data.questions[qid];
  return html`<div class="stack">
    <div class="mock-bar">
      <span class="practice-stats">
        <strong class=${`combo ${combo >= 3 ? "hot" : ""}`} key=${combo}>${combo >= 2 ? `🔥 ×${combo}` : `${right}/${answered.length}`}</strong>
        <span class="small muted">${today}/${settings.l1_daily_goal} today${game ? ` · ${sessionXp >= 0 ? "+" : ""}${sessionXp} XP` : ""}</span>
      </span>
      <button class="btn" onClick=${() => setEnded(true)}>Exit</button>
    </div>
    ${celebrate ? html`<div class="celebrate" role="status" onClick=${() => setCelebrate(false)}>
      <span class="confetti" aria-hidden="true">🎉✨🎯✨🎉</span><strong>Daily goal reached!</strong>
      <span class="small">${goalStreak(events, settings.l1_daily_goal)}-day streak · keep going or call it a day</span></div>` : null}
    <article class="qcard">
      <div class="spread small muted"><span>${why === "comeback" ? html`<span class="chip review">Comeback ⟲</span> ` : why === "review" ? html`<span class="chip review">Review ⟲</span> ` : null}
        ${data.topics[q.topic]}</span>
        <${FlagButton} qid=${qid} flagged=${flagged} /></div>
      ${q.context.length ? html`<div class="vignette"><${Text} blocks=${q.context} /></div>` : null}
      <${Text} blocks=${q.stem} />
      <div class="options" role="radiogroup" aria-label="Answer options">${q.options.map((opt, i) => html`<button
        class=${`option ${!choice ? "" : LETTERS[i] === q.answer ? "right" : LETTERS[i] === choice ? "wrong" : ""}`}
        role="radio" aria-checked=${(choice ?? pick) === LETTERS[i]} disabled=${!!choice} onClick=${() => select(LETTERS[i])}>
        <span class="letter">${LETTERS[i]}</span><span>${opt}</span></button>`)}</div>
      ${game && pick && !choice ? html`<div class="bets" role="group" aria-label="How sure are you? Place your bet">
        <span class="small muted">How sure? Bet XP on ${pick}:</span>
        ${Object.entries(BETS).map(([k, b]) => html`<button class="btn bet" onClick=${() => answer(pick, k)}>
          <strong>${b.label}</strong><span class="small">${b.stake} XP · wins ${Math.round(b.stake * b.mult)}</span></button>`)}
      </div>` : null}
      ${choice ? html`<div class=${`feedback ${choice === q.answer ? "ok" : "bad"}`} role="status">
        <div class="spread"><strong>${choice === q.answer ? "✓ Correct" : `✗ Incorrect: the answer is ${q.answer}`}</strong>
          ${game ? html`<strong class=${`payout ${result.payout >= 0 ? "win" : "loss"}`}>${result.payout >= 0 ? "+" : ""}${result.payout} XP</strong>` : null}</div>
        ${result.combo > 0 && result.combo % 5 === 0 ? html`<div class="small"><strong>Combo ×${result.combo}!</strong> bonus XP</div>` : null}
        <${Text} blocks=${q.explanation} />
        ${choice === q.answer ? null : html`<${StudyPointer} q=${q} data=${data} />`}
      </div>
      ${game ? html`<${ChestButton} events=${events} />` : null}` : null}
    </article>
    <div class="row sticky-actions">
      ${choice ? html`<button class="btn primary" onClick=${next}>${limit !== null && answered.length >= limit ? "See summary" : "Next question"}</button>`
        : html`<button class="btn" onClick=${next}>Skip</button>`}
    </div>
    <p class="small muted kbd-hint">Keys: A/B/C answer${game ? " · 1/2/3 bet" : ""} · Enter next · F flag</p>
  </div>`;
}

// ---------------------------------------------------------------- wrong / flagged lists

export function L1List({ kind }) {
  const { value: data, error } = useAsync(getLevel1, []);
  const events = useEvents();
  if (error) return html`<${ErrorBox} error=${error} />`;
  if (!data || !events) return html`<${Loading} />`;
  const flagged = flaggedSet(events);
  const state = practiceState(events, data.pool);
  const ids = kind === "wrong" ? state.wrong : [...flagged];
  return html`<div class="stack">
    <h1>${kind === "wrong" ? "Wrong answers" : "Flagged questions"}</h1>
    <p class="small muted">${kind === "wrong" ? "Questions whose latest practice answer was wrong. Answer one correctly and it leaves this list."
      : "Questions you flagged as unsure. Unflag them here or while practising."}</p>
    ${ids.length ? html`<div><a class="btn primary" href=${href("l1", "practice", kind)}>Practise these (${ids.length})</a></div>
      ${ids.map((id, i) => html`<${ReviewCard} key=${id} qid=${id} q=${data.questions[id]} data=${data} choice=${state.latest.get(id)?.choice ?? null}
        label=${`#${i + 1}`} flagged=${flagged} collapsed=${true} />`)}`
      : html`<p class="muted">${kind === "wrong" ? "No wrong answers right now." : "Nothing flagged."}</p>`}
    <a class="btn" href="#/">Back to Level I</a>
  </div>`;
}

// ---------------------------------------------------------------- mock session

export function L1Session({ mockId, n }) {
  const { value: data, error } = useAsync(getLevel1, []);
  const [state, setState] = useState(undefined);
  const [, tick] = useState(0);
  const key = stateKey(mockId, n);
  // Resuming after an exit restarts the clock where it stopped.
  useEffect(() => {
    kvGet(key).then((s) => {
      if (s?.pausedAt) {
        const { pausedAt, ...rest } = s;
        s = { ...rest, startedAt: s.startedAt + (Date.now() - pausedAt) };
        kvSet(key, s);
      }
      setState(s ?? null);
    });
  }, [key]);
  useEffect(() => { const id = setInterval(() => tick((x) => x + 1), 1000); return () => clearInterval(id); }, []);

  const mock = data?.mocks.find((m) => m.id === mockId);
  const session = mock?.sessions.find((s) => String(s.n) === String(n));
  const remaining = state && session ? state.startedAt + session.minutes * 60_000 - Date.now() : 1;

  const save = (fn) => setState((prev) => { const next = fn(prev); kvSet(key, next); return next; });
  const submit = async () => {
    const s = state;
    const ids = session.questions;
    const correct = ids.filter((id) => s.answers[id] === data.questions[id].answer).length;
    await logEvent("l1session", { mock: mockId, session: Number(n), answers: s.answers, correct, n: ids.length,
      ms: Math.round(Math.min(Date.now() - s.startedAt, session.minutes * 60_000)) });
    await kvDel(key);
    location.hash = href("l1", mockId, String(n), "review");
  };
  const exit = async () => {
    if (!confirm("Exit the mock? Your answers are saved and the clock pauses until you resume.")) return;
    await kvSet(key, { ...state, pausedAt: Date.now() });
    location.hash = "#/";
  };
  useEffect(() => { if (state && session && remaining <= 0) submit(); }, [state && session && remaining <= 0]);

  // Laptop keys: A/B/C answer, arrows move, F flags
  useEffect(() => {
    if (!state || !session) return undefined;
    const onKey = (e) => {
      if (e.ctrlKey || e.metaKey || e.altKey || e.target.closest?.("input, textarea")) return;
      const qid = session.questions[state.active];
      const k = e.key.toUpperCase();
      if (LETTERS.includes(k)) save((s) => ({ ...s, answers: { ...s.answers, [qid]: k } }));
      else if (k === "F") save((s) => ({ ...s, flags: { ...s.flags, [qid]: !s.flags[qid] } }));
      else if (e.key === "ArrowRight") save((s) => ({ ...s, active: Math.min(s.active + 1, session.questions.length - 1) }));
      else if (e.key === "ArrowLeft") save((s) => ({ ...s, active: Math.max(s.active - 1, 0) }));
      else return;
      e.preventDefault();
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  });
  useEffect(() => { window.scrollTo(0, 0); }, [state?.active]);

  if (error) return html`<${ErrorBox} error=${error} />`;
  if (!data || state === undefined) return html`<${Loading} />`;
  if (!session) return html`<p>Unknown session.</p>`;
  if (!state) return html`<div class="stack"><p>This session isn't running.</p><a class="btn" href="#/">Back to Level I</a></div>`;

  const ids = session.questions;
  const qid = ids[state.active];
  const q = data.questions[qid];
  const answered = ids.filter((id) => state.answers[id]).length;
  const go = (i) => save((s) => ({ ...s, active: i }));
  return html`<div class="stack">
    <div class="mock-bar">
      <strong class=${remaining < 10 * 60_000 ? "late" : ""}>${clock(remaining)}</strong>
      <span class="small muted">${mock.title} · Session ${n} · ${answered}/${ids.length} answered</span>
      <span class="row">
        <button class="btn" onClick=${exit}>Exit</button>
        <button class="btn" onClick=${() => { if (confirm(`Submit session ${n}? ${ids.length - answered} questions unanswered.`)) submit(); }}>Submit</button>
      </span>
    </div>
    <article class="qcard">
      <div class="spread small muted"><span>Question ${state.active + 1} of ${ids.length} · ${data.topics[q.topic]}</span>
        <button class=${`btn flag ${state.flags[qid] ? "on" : ""}`} aria-pressed=${!!state.flags[qid]}
          onClick=${() => save((s) => ({ ...s, flags: { ...s.flags, [qid]: !s.flags[qid] } }))}>⚑ Flag</button></div>
      ${q.context.length ? html`<div class="vignette"><${Text} blocks=${q.context} /></div>` : null}
      <${Text} blocks=${q.stem} />
      <div class="options" role="radiogroup" aria-label="Answer options">${q.options.map((opt, i) => html`<button
        class="option" role="radio" aria-checked=${state.answers[qid] === LETTERS[i]}
        onClick=${() => save((s) => ({ ...s, answers: { ...s.answers, [qid]: LETTERS[i] } }))}>
        <span class="letter">${LETTERS[i]}</span><span>${opt}</span></button>`)}</div>
    </article>
    <div class="row sticky-actions">
      <button class="btn" disabled=${state.active === 0} onClick=${() => go(state.active - 1)}>‹ Previous</button>
      ${state.active + 1 < ids.length ? html`<button class="btn primary" onClick=${() => go(state.active + 1)}>Next ›</button>`
        : html`<button class="btn primary" onClick=${() => { if (confirm(`Submit session ${n}?`)) submit(); }}>Submit session</button>`}
    </div>
    <details class="card"><summary>All questions (${answered} answered${Object.values(state.flags).filter(Boolean).length ? `, ${Object.values(state.flags).filter(Boolean).length} flagged` : ""})</summary>
      <nav class="mock-nav" aria-label="Questions">${ids.map((id, i) => html`<button aria-current=${i === state.active ? "step" : undefined}
        class=${`${state.answers[id] ? "done" : ""} ${state.flags[id] ? "flagged" : ""}`} onClick=${() => go(i)}>${i + 1}</button>`)}</nav>
      <p class="small muted kbd-hint">Keys: A/B/C answer · ← → move · F flag</p>
    </details>
  </div>`;
}

// ---------------------------------------------------------------- mock review

export function L1Review({ mockId, n }) {
  const { value: data, error } = useAsync(getLevel1, []);
  const events = useEvents();
  const [filter, setFilter] = useState("wrong");
  const attempt = useMemo(() => latestAttempts(events).get(`${mockId}:${n}`), [events?.length, mockId, n]);
  if (error) return html`<${ErrorBox} error=${error} />`;
  if (!data || !events) return html`<${Loading} />`;
  const mock = data.mocks.find((m) => m.id === mockId);
  const session = mock?.sessions.find((s) => String(s.n) === String(n));
  if (!session || !attempt) return html`<div class="stack"><p>No finished attempt for this session yet.</p><a class="btn" href="#/">Back to Level I</a></div>`;

  const answers = attempt.payload.answers;
  const flagged = flaggedSet(events);
  const rows = session.plan.map((p) => {
    const ids = session.questions.filter((id) => data.questions[id].topic === p.topic);
    return { topic: p.topic, n: ids.length, correct: ids.filter((id) => answers[id] === data.questions[id].answer).length };
  });
  const list = session.questions.map((id, i) => ({ id, i, q: data.questions[id], choice: answers[id] }))
    .filter((x) => filter === "all" || x.choice !== x.q.answer);
  const study = studyList(data, [attempt]);
  const acc = attempt.payload.correct / attempt.payload.n;

  return html`<div class="stack">
    <h1>${mock.title} · Session ${n}</h1>
    <div class="tiles">
      <div class="tile"><div class="k">Score</div><div class="v">${pct(acc)}</div>
        <div class="sub">${attempt.payload.correct}/${attempt.payload.n} correct · guide ${pct(GUIDE)}</div></div>
      <div class="tile"><div class="k">Time used</div><div class="v">${clock(attempt.payload.ms)}</div>
        <div class="sub">of 2:15:00 · ${formatDate(attempt.ts)}</div></div>
    </div>
    <div class="table-wrap card"><table><thead><tr><th>Topic</th><th class="n">Questions</th><th class="n">Correct</th><th class="n">Score</th></tr></thead>
      <tbody>${rows.map((r) => html`<tr><td>${data.topics[r.topic]}</td><td class="n">${r.n}</td><td class="n">${r.correct}</td>
        <td class="n" style=${r.correct / r.n < GUIDE ? "color:var(--bad)" : ""}>${pct(r.correct / Math.max(r.n, 1))}</td></tr>`)}</tbody></table></div>

    ${study.length ? html`<h2 class="section-title">What to study</h2>
      <ul class="list">${study.map((g) => html`<li><div class="item"><div class="grow">
        <div>${data.topics[g.topic]} › LM ${g.lm}: ${g.title}</div>
        <div class="sub">Volume ${g.volume}${g.page ? `, practice problems from p. ${g.page}` : ""}</div></div>
        <span class="chip review">${g.wrong} wrong</span></div></li>`)}</ul>` : null}

    <div class="spread"><h2 class="section-title" style="margin:0">Questions</h2>
      <div class="seg" role="group" aria-label="Show">${[["wrong", "Wrong & skipped"], ["all", "All"]].map(([v, label]) => html`<button
        aria-pressed=${filter === v} onClick=${() => setFilter(v)}>${label}</button>`)}</div></div>
    <p class="small muted">Flag a question to practise it later from Quick practice → Flagged.</p>
    ${list.length ? list.map(({ id, i, q, choice }) => html`<${ReviewCard} key=${id} qid=${id} q=${q} data=${data} choice=${choice}
      label=${`Question ${i + 1}`} flagged=${flagged} />`) : html`<p class="muted">Every question in this session was answered correctly.</p>`}
    <a class="btn" href="#/">Back to Level I</a>
  </div>`;
}
