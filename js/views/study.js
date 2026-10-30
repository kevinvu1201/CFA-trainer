import { chunkNow, getChunk, manifest, topicInfo } from "../core/data.js";
import { href } from "../core/router.js";
import { html } from "../lib.js";
import { Blocks, useAsync } from "../ui.js";

export function Topics() {
  return html`<div class="stack">
    <div class="spread"><h1>Study</h1>${manifest().graph ? html`<a class="btn" href="#/map">Concept map</a>` : null}</div>
    <ul class="list">
      ${manifest().topics.map((t) => html`<li><a href=${href("study", t.id)}>
        <div class="grow"><strong>${t.name}</strong>
          <div class="sub">${t.readings.length} readings · ${t.counts.modules} modules · ${t.counts.los} LOS</div></div>
        <span class="chip accent">${(t.weight * 100).toFixed(1)}%</span><span class="chev">›</span>
      </a></li>`)}
    </ul>
  </div>`;
}

export function Topic({ id }) {
  const topic = topicInfo(id);
  // The reading list comes from the manifest (instant); exam-focus notes need the chunk.
  const { value: chunk } = useAsync(() => chunkNow(id) ?? getChunk(id), [id]);
  if (!topic) return html`<p>Unknown topic.</p>`;
  const readings = new Map((chunk?.readings ?? []).map((r) => [r.id, r]));

  return html`<div class="stack">
    <div class="crumbs"><a href="#/study">Study</a></div>
    <h1>${topic.name}</h1>
    <p class="muted small">${(topic.weight * 100).toFixed(1)}% of the exam (range ${topic.weight_range[0]}–${topic.weight_range[1]}%)</p>
    ${topic.readings.map((r) => html`<section>
      <h2 class="section-title">Reading ${r.n}</h2>
      <h3 style="margin:0 0 8px">${r.title}</h3>
      ${readings.get(r.id)?.exam_focus?.length ? html`<details class="card" style="margin-bottom:10px">
        <summary>Exam focus</summary><div class="reader"><${Blocks} blocks=${readings.get(r.id).exam_focus} chunk=${chunk} /></div>
      </details>` : null}
      <ul class="list">
        ${r.modules.map((m) => html`<li><a href=${href("m", m.id)}>
          <div class="grow"><div>${m.title}</div><div class="sub">Module ${m.id.slice(1).replace(/^0/, "")} · ${m.los.length} LOS</div></div>
          <span class="chev">›</span>
        </a></li>`)}
      </ul>
    </section>`)}
  </div>`;
}
