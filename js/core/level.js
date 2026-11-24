// Which exam the app is set up for. CFA Level II and the other spaces (FRM Part I) are the full
// study app; CFA Level I has mock exams built from the curriculum practice problems
// (builder/level1.py). The CFA level is a synced setting; the space is chosen per device.

import { html } from "../lib.js";
import { mainManifest, manifest } from "./data.js";
import { useEvents } from "./events.js";
import { saveSetting, settingsFrom } from "./settings.js";
import { CFA, currentSpace, examChoices, openSpace } from "./space.js";

export const hasLevel1 = () => Boolean(manifest()?.level1);

export function useLevel() {
  const events = useEvents();
  const level = events ? settingsFrom(events).level : 2;
  return level === 1 && hasLevel1() ? 1 : 2;
}

async function choose(c, level) {
  if (c.space !== currentSpace()) {
    if (c.level) await saveSetting("level", c.level);
    openSpace(c.space);
  } else if (c.level !== level) {
    saveSetting("level", c.level);
    location.hash = "#/";
  }
}

/** CFA I / CFA II / FRM I toggle shown at the top of each home screen and in Settings. */
export function LevelSwitch({ level }) {
  const choices = examChoices(mainManifest());
  if (choices.length < 2) return null;
  const on = (c) => c.space === currentSpace() && (c.space !== CFA || c.level === level);
  return html`<div class="seg level-switch" role="group" aria-label="Exam">
    ${choices.map((c) => html`<button aria-pressed=${on(c)} onClick=${() => choose(c, level)}>${c.label}</button>`)}
  </div>`;
}
