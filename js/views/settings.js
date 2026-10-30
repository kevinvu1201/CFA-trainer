import { downloadAll, forgetKey, isEncrypted, manifest, storageInfo } from "../core/data.js";
import { useEvents } from "../core/events.js";
import { saveSetting, settingsFrom } from "../core/settings.js";
import { downloadProgress, importFile, saveGistSettings, syncGist, useSyncStatus } from "../core/sync.js";
import { getTheme, setTheme } from "../core/theme.js";
import { html, useState } from "../lib.js";
import { useAsync } from "../ui.js";

const mb = (bytes) => (bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : `${(bytes / 1048576).toFixed(1)} MB`);

function ProgressData() {
  const events = useEvents();
  const [msg, setMsg] = useState(null); // {ok, text}
  const [busy, setBusy] = useState(false);
  const gist = useSyncStatus();
  const [token, setToken] = useState(null);
  const [gistId, setGistId] = useState(null);
  const run = async (fn) => {
    setBusy(true); setMsg(null);
    try { setMsg({ ok: true, text: await fn() }); } catch (e) { setMsg({ ok: false, text: e.message }); }
    setBusy(false);
  };
  const exportNow = () => run(async () => `Saved ${await downloadProgress()} events to a file.`);
  const importNow = (e) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (file) run(async () => {
      const r = await importFile(file);
      return `Added ${r.fresh.length} new events; ${r.duplicates} were already here${r.invalid ? `; ${r.invalid} invalid skipped` : ""}.`;
    });
  };
  const sync = () => run(async () => {
    const settings = { ...gist, token: token ?? gist.token, id: gistId ?? gist.id };
    await saveGistSettings(settings);
    const r = await syncGist(settings);
    setGistId(r.id);
    return `Synced: ${r.pulled} new events from the Gist; ${r.pushed} events now stored there.`;
  });
  return html`<section class="card stack">
    <strong>Progress & devices</strong>
    <p class="small muted">${events ? `${events.length} events on this device.` : ""} Progress is a log of events, so merging two
      devices never double-counts: importing the same file twice changes nothing.</p>
    <div class="row">
      <button class="btn" disabled=${busy} onClick=${exportNow}>Export progress</button>
      <label class="btn">Import progress<input type="file" accept="application/json,.json" class="sr-only" onChange=${importNow} /></label>
    </div>
    <details>
      <summary>Sync through a private GitHub Gist (optional)</summary>
      <p class="small muted">Create a GitHub token with only the <code>gist</code> scope. It is stored on this device only. Leave the Gist id
        empty on the first device; copy the id it creates to your other devices. After the first sync, each device syncs by itself
        when the app opens, a minute after you answer questions, and when you leave the app.</p>
      <label class="stack small">Token<input type="password" autocomplete="off" value=${token ?? gist?.token ?? ""} onInput=${(e) => setToken(e.target.value)} /></label>
      <label class="stack small">Gist id<input type="text" value=${gistId ?? gist?.id ?? ""} onInput=${(e) => setGistId(e.target.value.trim())} /></label>
      <div class="row"><button class="btn primary" disabled=${busy || !(token ?? gist?.token)} onClick=${sync}>Sync now</button>
        ${gist?.lastSync ? html`<span class="small muted">Last sync ${new Date(gist.lastSync).toLocaleString()}</span>` : null}</div>
    </details>
    ${msg ? html`<p class="small" role="status" style=${`color:var(${msg.ok ? "--ok" : "--bad"})`}>${msg.text}</p>` : null}
  </section>`;
}

function StudySettings() {
  const events = useEvents();
  if (!events) return null;
  const s = settingsFrom(events);
  const defaultTarget = manifest().scoring.readiness.target;
  const target = s.target ?? defaultTarget;
  return html`<section class="card stack">
    <strong>Study plan</strong>
    <label class="spread"><span>Exam date</span>
      <input type="date" value=${s.exam_date ?? ""} onChange=${(e) => saveSetting("exam_date", e.target.value || null)} /></label>
    <div class="spread"><span>Daily Smart Session</span>
      <div class="seg" role="group" aria-label="Daily minutes">${[15, 30, 60].map((m) => html`<button aria-pressed=${s.daily_minutes === m}
        onClick=${() => saveSetting("daily_minutes", m)}>${m} min</button>`)}</div></div>
    <div class="spread"><span>Weekend workload<span class="small muted" style="display:block">vs. a weekday, in the study plan</span></span>
      <div class="seg" role="group" aria-label="Weekend workload">${[1, 1.5, 2, 3].map((r) => html`<button aria-pressed=${s.weekend_ratio === r}
        onClick=${() => saveSetting("weekend_ratio", r)}>${r}×</button>`)}</div></div>
    <label class="spread"><span>Readiness target (%)</span>
      <input type="number" min="50" max="95" step="1" value=${Math.round(target * 100)} style="width:6em"
        onChange=${(e) => { const v = Number(e.target.value); if (v >= 50 && v <= 95) saveSetting("target", v / 100); }} /></label>
    <p class="small muted">Settings are saved in your progress log, so they move with your progress between devices.</p>
  </section>`;
}

export function Settings() {
  const [theme, setThemeState] = useState(getTheme());
  const [dl, setDl] = useState(null); // {done, total} | "done" | Error
  const [tick, setTick] = useState(0);
  const { value: storage } = useAsync(storageInfo, [tick]);
  const m = manifest();

  const pickTheme = (t) => { setTheme(t); setThemeState(t); };
  const download = async () => {
    setDl({ done: 0, total: m.topics.length });
    try {
      await navigator.storage?.persist?.();
      await downloadAll((done, total) => setDl({ done, total }));
      setDl("done");
    } catch (e) {
      setDl(e);
    }
    setTick((n) => n + 1);
  };
  const lock = async () => { await forgetKey(); location.reload(); };

  return html`<div class="stack">
    <h1>Settings</h1>

    <${StudySettings} />
    <${ProgressData} />

    <section class="card stack">
      <strong>Appearance</strong>
      <div class="seg" role="group" aria-label="Theme">
        ${["system", "light", "dark"].map((t) => html`<button aria-pressed=${theme === t} onClick=${() => pickTheme(t)}>
          ${t[0].toUpperCase() + t.slice(1)}</button>`)}
      </div>
    </section>

    <section class="card stack">
      <strong>Offline</strong>
      <p class="small muted">Topics you open are saved automatically. Download everything once on Wi-Fi to study anywhere.</p>
      ${dl && typeof dl === "object" && !(dl instanceof Error) ? html`
        <div class="progress" role="progressbar" aria-valuenow=${dl.done} aria-valuemax=${dl.total}>
          <span style=${`width:${(100 * dl.done) / Math.max(dl.total, 1)}%`}></span></div>
        <p class="small muted">${dl.done} of ${dl.total} files</p>`
      : html`<div><button class="btn primary" onClick=${download}>${dl === "done" ? "Downloaded ✓ Check again" : "Download all content"}</button></div>`}
      ${dl instanceof Error ? html`<p class="small" style="color:var(--bad)">Download stopped: ${dl.message}</p>` : null}
      ${storage ? html`<p class="small muted">This app is using ${mb(storage.usage)} on this device${m.content_bytes ? ` (all content is about ${Math.ceil(m.content_bytes / 1048576)} MB)` : ""}
        ${storage.persisted ? " · protected from automatic clean-up" : ""}</p>` : null}
    </section>

    ${isEncrypted() ? html`<section class="card stack">
      <strong>Passphrase</strong>
      <p class="small muted">This device remembers the passphrase. Forget it to lock the content again.</p>
      <div><button class="btn" onClick=${lock}>Forget passphrase on this device</button></div>
    </section>` : null}

    <section class="card small muted">
      Content ${m.content_version} · built ${new Date(m.built_at).toLocaleString()}
    </section>
  </div>`;
}
