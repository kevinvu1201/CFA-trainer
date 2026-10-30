import { ReadinessBars } from "../charts.js";
import { formatDate, pct } from "../core/analytics.js";
import { installed, manifest, moduleInfo } from "../core/data.js";
import { useEvents } from "../core/events.js";
import { buildModel, streak } from "../core/mastery.js";
import { dailyPlan, setFinished } from "../core/plan.js";
import { href } from "../core/router.js";
import { saveSetting, settingsFrom } from "../core/settings.js";
import { kvGet, kvSet } from "../core/store.js";
import { useSyncStatus } from "../core/sync.js";
import { html, useMemo, useState } from "../lib.js";
import { Loading, useAsync } from "../ui.js";

const DAY = 86_400_000;
const losLabel = (id) => id.replace(/^los\.0?/, "LOS ");

/** Shown while the browser may still clear our data: not installed and storage not marked persistent. */
function InstallHint() {
  const [hidden, setHidden] = useState(false);
  const { value: show } = useAsync(async () => !installed() && !(await navigator.storage?.persisted?.()) && !(await kvGet("installHintDismissed")), []);
  if (!show || hidden) return null;
  const dismiss = () => { setHidden(true); kvSet("installHintDismissed", true); };
  return html`<div class="banner stack" role="note">
    <span>Your progress lives in this browser, which may clear it if you don't visit for a while. Install the app to keep it safe:
      on iPhone, Safari → Share → <b>Add to Home Screen</b>; on Android or desktop Chrome, menu → <b>Install app</b>.
      Syncing or exporting progress (Settings) also keeps a copy.</span>
    <div><button class="btn" onClick=${dismiss}>Got it</button></div>
  </div>`;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
const dayLabel = (ts) => `${WEEKDAYS[new Date(ts).getDay()]} ${new Date(ts).getDate()}`;

/** Plan modules with a tick box to mark each finished (the row itself opens the module). */
function PlanList({ modules }) {
  return html`<ul class="list plan-list">${modules.map((mod) => html`<li>
    <button class=${`tick ${mod.done ? "on" : ""}`} aria-pressed=${!!mod.done} aria-label=${`Finished: ${mod.title}`}
      onClick=${() => setFinished(mod.id, mod.topic, !mod.done)}>${mod.done ? "✓" : ""}</button>
    <a href=${href("m", mod.id)}><div class="grow"><div class=${mod.done ? "muted" : ""}>${mod.title}</div>
      <div class="sub">${mod.topicName} · ${mod.load} LOS${mod.carried ? " · " : ""}${mod.carried ? html`<span class="chip review">carried over</span>` : null}</div></div>
      <span class="chev">›</span></a></li>`)}</ul>`;
}

function PaceLine({ plan }) {
  const d = plan.aheadDays;
  const rebalance = html`<button class="btn" onClick=${() => saveSetting("plan_reset", new Date().toISOString().slice(0, 10))}>Rebalance plan</button>`;
  if (d === 0) return html`<p class="small" style="color:var(--ok)">On track</p>`;
  return html`<div class="spread"><span class="small" style=${`color:var(${d > 0 ? "--ok" : "--warn"})`}>
      ${d > 0 ? `${Math.abs(d)} ${Math.abs(d) === 1 ? "day" : "days"} ahead` : `${Math.abs(d)} ${Math.abs(d) === 1 ? "day" : "days"} behind`}
      <span class="muted">${d > 0 ? " · rebalance to make every day lighter" : " · rebalance to spread the backlog over the days left"}</span></span>
    ${rebalance}</div>`;
}

function PlanSummary({ plan }) {
  if (plan.daysLeft == null) return html`<p class="small muted">${plan.remaining} of ${plan.total} modules not started.
    <a href="#/settings">Set your exam date</a> to get a day-by-day plan.</p>`;
  if (plan.inFinalReview) return html`<p class="small">Final-review window: no new material. Focus on Smart Sessions and reviews.</p>`;
  const today = plan.schedule[0];
  const done = plan.today.filter((m) => m.done).length;
  return html`<p class="small muted">${plan.remaining} of ${plan.total} modules not finished, finishing by ${formatDate(plan.finishBy)} (${plan.finalReview} days
    before the exam, kept for review). Weekend days carry ${plan.ratio}× a weekday's load.</p>
    <${PaceLine} plan=${plan} />
    ${plan.today.length ? html`<p class="small"><strong>Today: ${plural(plan.today.length, "module")} · ${today.load} LOS</strong>${done ? ` · ${done} finished` : ""}
      ${plan.carried ? html` · ${plan.carried} carried over from earlier days` : null}</p>` : null}`;
}

/** The next seven days as small cells, then the whole schedule on demand. */
function WeekAhead({ schedule }) {
  const week = schedule.slice(1, 8);
  return html`${week.length ? html`<div>
      <div class="small muted">Coming up (modules · LOS)</div>
      <div class="week">${week.map((d) => html`<div class=${`day ${d.weekend ? "weekend" : ""}`}>
        <div class="wd">${WEEKDAYS[new Date(d.date).getDay()]} ${new Date(d.date).getDate()}</div><strong>${d.modules.length}</strong>
        <div class="wd">${d.load} LOS</div></div>`)}</div>
    </div>` : null}
    <details>
      <summary class="small">Whole schedule (${schedule.length} days)</summary>
      <ul class="plain small schedule">${schedule.map((d, k) => html`<li class=${d.weekend ? "weekend" : ""}>
        <strong>${k === 0 ? "Today" : dayLabel(d.date)}</strong> <span class="muted">${formatDate(d.date)} · ${d.load} LOS</span>
        <div>${d.modules.length ? d.modules.map((m) => m.title).join(" · ") : html`<span class="muted">Review day</span>`}</div></li>`)}</ul>
    </details>`;
}

/** One line of Gist sync state, once sync is set up. */
function SyncLine() {
  const s = useSyncStatus();
  if (!s?.token || !s.id) return null;
  if (s.lastError) return html`<p class="small" style="color:var(--bad)">Sync failed (${s.lastError}). <a href="#/settings">Check Settings</a></p>`;
  return s.lastSync ? html`<p class="small muted">Synced with your other devices ${formatAgo(s.lastSync)}</p>` : null;
}

function formatAgo(ts) {
  const min = Math.round((Date.now() - ts) / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  return min < 1440 ? `${Math.round(min / 60)} h ago` : `on ${formatDate(ts)}`;
}

export function Home() {
  const m = manifest();
  const events = useEvents();
  const { value: last } = useAsync(() => kvGet("lastModule"), []);
  const count = events?.length ?? -1;
  const settings = useMemo(() => (events ? settingsFrom(events) : null), [count]);
  const model = useMemo(() => (events ? buildModel(events, m, Date.now(), { target: settings.target ?? undefined }) : null), [count]);
  if (!events) return html`<${Loading} />`;

  const target = model.overall.target;
  const plan = dailyPlan(m, events, settings);
  const days = streak(events);
  const dueQuestions = [...model.cardMeta].filter(([id, c]) => c.kind === "question" && !id.startsWith("set.") && model.status.get(id).overdueDays >= 0).length;
  const dueCards = [...model.cardMeta].filter(([id, c]) => c.kind === "formula" && model.status.get(id).overdueDays >= 0);
  const cardTopic = dueCards.length ? mostCommon(dueCards.map(([, c]) => c.topic)) : null;
  const weak = [...model.los.values()].filter((l) => l.n > 0).sort((a, b) => b.priority - a.priority).slice(0, 5);
  const lastInfo = last && moduleInfo(last);
  const answered = events.some((e) => e.type === "answer");

  return html`<div class="stack">
    <h1>CFA Level II</h1>
    ${!m.weights_verified ? html`<p class="banner">Exam weights are unverified. Check them against CFA Institute's
      Level II topic weights and update <code>config/exam_weights.yaml</code>.</p>` : null}
    <${InstallHint} />
    <${SyncLine} />

    <div class="tiles">
      <a class="tile" href=${plan.daysLeft == null ? "#/settings" : "#/"} style="text-decoration:none;color:inherit">
        <div class="k">Exam</div>
        <div class="v">${plan.daysLeft == null ? "Set date" : plan.daysLeft >= 0 ? `${plan.daysLeft} days` : "Done"}</div>
        <div class="sub">${settings.exam_date ? formatDate(`${settings.exam_date}T00:00`) : "tap to set in Settings"}</div></a>
      <div class="tile"><div class="k">Readiness</div><div class="v">${answered ? pct(model.overall.mean) : "—"}</div>
        <div class="sub">${answered ? `likely ${pct(model.overall.lo)}–${pct(model.overall.hi)} · target ${pct(target)}` : "practise to estimate"}</div></div>
      <div class="tile"><div class="k">Streak</div><div class="v">${days} ${days === 1 ? "day" : "days"}</div><div class="sub">days in a row with practice</div></div>
      <div class="tile"><div class="k">Reviews due</div><div class="v">${dueQuestions + dueCards.length}</div>
        <div class="sub">${dueQuestions} questions · ${dueCards.length} formula cards</div></div>
    </div>

    <section class="card stack">
      <strong>Today's plan</strong>
      <${PlanSummary} plan=${plan} />
      ${plan.today.length ? html`<${PlanList} modules=${plan.today} />`
        : plan.schedule.length ? html`<p class="small muted">No new modules today. A Smart Session keeps earlier material fresh.</p>` : null}
      ${plan.schedule.length && plan.today.every((m) => m.done) && plan.studyAhead.length ? html`
        ${plan.today.length ? html`<p class="small" style="color:var(--ok)"><strong>Done for today ✓</strong></p>` : null}
        <p class="small"><strong>Study ahead</strong><span class="muted"> · modules finished early free up later days</span></p>
        <${PlanList} modules=${plan.studyAhead} />` : null}
      ${plan.schedule.length ? html`<${WeekAhead} schedule=${plan.schedule} />` : null}
      <div class="row">
        <a class="btn primary" href=${href("practice", "smart", String(settings.daily_minutes))}>Smart Session · ${settings.daily_minutes} min</a>
        ${dueCards.length ? html`<a class="btn" href=${href("practice", "cards", cardTopic)}>Formula cards (${dueCards.length} due)</a>` : null}
        ${lastInfo ? html`<a class="btn" href=${href("m", last)}>Continue reading</a>` : null}
      </div>
    </section>

    ${weak.length ? html`<h2 class="section-title">Weak spots (highest priority)</h2>
      <ul class="list">${weak.map((l) => html`<li><a href=${href("practice", "drill", l.topic, l.module)}>
        <div class="grow"><strong>${losLabel(l.id)}</strong>
          <div class="sub">mastery ${pct(l.mean)} (${pct(l.lo)}–${pct(l.hi)}) · ${l.n} answers · ${l.last ? `${Math.round((Date.now() - l.last) / DAY)} days ago` : ""}</div></div>
        <span class=${`chip ${l.mean < target ? "warn" : ""}`}>${pct(l.mean)}</span><span class="chev">›</span></a></li>`)}</ul>` : null}

    <h2 class="section-title">Readiness by topic</h2>
    <p class="small muted">Average mastery across each topic's LOS; LOS you haven't practised count at a guessing-level prior.
      The thin line shows the likely range (treating LOS as independent); the tick is your ${pct(target)} target.</p>
    <${ReadinessBars} target=${target} rows=${[...model.topics.values()].sort((a, b) => b.weight - a.weight)
      .map((t) => ({ label: t.name, mean: t.mean, lo: t.lo, hi: t.hi, coverage: t.coverage, weight: t.weight }))} />
    <p class="small muted">Content ${m.content_version} · built ${formatDate(m.built_at)}</p>
  </div>`;
}

function mostCommon(list) {
  const counts = new Map();
  for (const x of list) counts.set(x, (counts.get(x) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1])[0][0];
}
