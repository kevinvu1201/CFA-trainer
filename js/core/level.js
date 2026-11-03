// Which exam the app is set up for. Level II is the full study app; Level I has mock exams built
// from the curriculum practice problems (builder/level1.py). The choice is a synced setting.

import { html } from "../lib.js";
import { manifest } from "./data.js";
import { useEvents } from "./events.js";
import { saveSetting, settingsFrom } from "./settings.js";

export const hasLevel1 = () => Boolean(manifest()?.level1);

export function useLevel() {
  const events = useEvents();
  const level = events ? settingsFrom(events).level : 2;
  return level === 1 && hasLevel1() ? 1 : 2;
}

/** Level I / Level II toggle shown at the top of each home screen. */
export function LevelSwitch({ level }) {
  if (!hasLevel1()) return null;
  return html`<div class="seg level-switch" role="group" aria-label="Exam level">
    ${[[1, "Level I"], [2, "Level II"]].map(([v, label]) => html`<button aria-pressed=${level === v}
      onClick=${() => { if (level !== v) { saveSetting("level", v); location.hash = "#/"; } }}>${label}</button>`)}
  </div>`;
}
