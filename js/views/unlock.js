import { unlock } from "../core/data.js";
import { html, useState } from "../lib.js";

// The passphrase input has no name attribute, so even if scripts fail a native
// form submit can't put the passphrase in the URL.
export function Unlock({ onUnlocked }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const submit = async (e) => {
    e.preventDefault();
    const pass = e.target.elements.pp.value;
    setBusy(true);
    setError("");
    try {
      if (await unlock(pass)) onUnlocked();
      else setError("That passphrase doesn't open this content.");
    } catch (err) {
      setError(`Couldn't unlock: ${err.message}`);
    }
    setBusy(false);
  };

  return html`<main><form class="card stack" style="margin-top:12vh" onSubmit=${submit}>
    <h1 style="margin:0">CFA Level II</h1>
    <p class="muted">Enter the passphrase once on this device. It stays on the device; nothing is sent anywhere.</p>
    <label class="sr-only" for="pp">Passphrase</label>
    <input id="pp" type="password" autocomplete="current-password" required autofocus />
    ${error ? html`<p role="alert" style="color:var(--bad);margin:0">${error}</p>` : null}
    <button class="btn primary" disabled=${busy}>${busy ? "Unlocking…" : "Unlock"}</button>
  </form></main>`;
}
