import { useContentLang, useTranslator } from "../core/i18n.js";
import { losWord } from "../core/space.js";
import { chunkNow, getChunk, manifest, topicInfo } from "../core/data.js";
import { useEvents } from "../core/events.js";
import { finishedModules, latestResults, moduleTally, readTally, topicModules, topicTally } from "../core/progress.js";
import { href } from "../core/router.js";
import { html, useMemo } from "../lib.js";
import { Blocks, ProgressRows, StackBar, useAsync } from "../ui.js";
import { pct } from "../core/analytics.js";

/** Read/practised progress inputs, recomputed only when the log changes. */
function useProgress() {
  const events = useEvents();
  return useMemo(() => (events ? { events, finished: finishedModules(events), results: latestResults(events) } : null), [events?.length]);
}

export function Topics() {
  const p = useProgress();
  const rows = manifest().topics.map((t) => ({
    t, read: p ? readTally(topicModules(t), p.finished) : null, practice: p ? topicTally(t, p.events, p.results) : null,
  }));
  const sum = (key, f) => rows.reduce((x, r) => x + (r[key]?.[f] ?? 0), 0);
  return html`<div class="stack">
    <div class="spread"><h1>Study</h1>${manifest().graph ? html`<a class="btn" href="#/map">Concept map</a>` : null}</div>
    ${p ? html`<section class="card stack">
      <strong>Overall progress</strong>
      <${ProgressRows} read=${{ read: sum("read", "read"), total: sum("read", "total") }}
        practice=${{ right: sum("practice", "right"), wrong: sum("practice", "wrong"), total: sum("practice", "total") }} />
      <p class="small muted">Read = modules you marked finished. Practised = questions answered at least once: green if your latest
        answer was right, red if it was wrong.</p>
    </section>` : null}
    <ul class="list">
      ${rows.map(({ t, read, practice }) => html`<li><a href=${href("study", t.id)}>
        <div class="grow"><strong>${t.name}</strong>
          <div class="sub">${t.readings.length} readings · ${t.counts.modules} modules · ${t.counts.los} ${losWord()}</div>
          ${read ? html`<${ProgressRows} read=${read} practice=${practice} />` : null}</div>
        <span class="chip accent">${(t.weight * 100).toFixed(1)}%</span><span class="chev">›</span>
      </a></li>`)}
    </ul>
  </div>`;
}

export function Topic({ id }) {
  const topic = topicInfo(id);
  // The reading list comes from the manifest (instant); exam-focus notes need the chunk.
  const { value: chunk } = useAsync(() => chunkNow(id) ?? getChunk(id), [id]);
  const t = useTranslator(id);
  const lang = useContentLang();
  const p = useProgress();
  if (!topic) return html`<p>Unknown topic.</p>`;
  const readings = new Map((chunk?.readings ?? []).map((r) => [r.id, r]));
  const frModules = new Set(lang === "fr" ? topic.fr?.modules ?? [] : []);

  return html`<div class="stack">
    <div class="crumbs"><a href="#/study">Study</a></div>
    <h1>${topic.name}</h1>
    <p class="muted small">${(topic.weight * 100).toFixed(1)}% of the exam (range ${topic.weight_range[0]}–${topic.weight_range[1]}%)</p>
    ${p ? html`<section class="card"><${ProgressRows} read=${readTally(topicModules(topic), p.finished)} practice=${topicTally(topic, p.events, p.results)} /></section>` : null}
    ${topic.readings.map((r) => html`<section>
      <h2 class="section-title">Reading ${r.n}</h2>
      <div class="spread"><h3 style="margin:0 0 8px">${t(r.title)}</h3>
        ${p ? html`<span class="small muted">${readTally(r.modules, p.finished).read}/${r.modules.length} read</span>` : null}</div>
      ${readings.get(r.id)?.exam_focus?.length ? html`<details class="card" style="margin-bottom:10px">
        <summary>Exam focus</summary><div class="reader"><${Blocks} blocks=${readings.get(r.id).exam_focus} chunk=${chunk} t=${t} /></div>
      </details>` : null}
      <ul class="list">
        ${r.modules.map((m) => {
          const mt = chunk && p ? moduleTally(chunk, m.id, p.results) : null;
          return html`<li><a href=${href("m", m.id)}>
          <div class="grow"><div>${t(m.title)}</div><div class="sub">Module ${m.id.slice(1).replace(/^0/, "")} · ${m.los.length} ${losWord()}
            ${mt && mt.total ? ` · ${mt.right + mt.wrong}/${mt.total} practised${mt.right + mt.wrong ? `, ${pct(mt.right / (mt.right + mt.wrong))} right` : ""}` : ""}</div>
            ${mt && mt.total ? html`<${StackBar} ...${mt} />` : null}</div>
          ${p?.finished.has(m.id) ? html`<span class="chip maintenance">✓ Read</span>` : null}
          ${frModules.has(m.id) ? html`<span class="chip accent">FR</span>` : null}
          <span class="chev">›</span>
        </a></li>`;
        })}
      </ul>
    </section>`)}
  </div>`;
}
