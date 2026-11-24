// Exam spaces. The main build is CFA (Level I and Level II); other exams (FRM Part I) are built by
// the same pipeline into data/<id>/ and open as a separate space: their own manifest, exam format
// and progress. Events logged in a space other than CFA carry payload.space, and each space sees
// only its own events (plus the settings they share), so the two exams never mix in one log.

export const CFA = "cfa";

/** Study-plan settings kept per space: each exam has its own date and pace. */
export const SPACE_KEYS = new Set(["exam_date", "daily_minutes", "target", "weekend_ratio"]);

const STORE_KEY = "space"; // localStorage: which space this device opens in

let current = CFA;
export const currentSpace = () => current;
export const setSpace = (id) => { current = id || CFA; };

/** The space this device last switched to (per device, read synchronously at startup). */
export function storedSpace() {
  try {
    return localStorage.getItem(STORE_KEY) || CFA;
  } catch {
    return CFA;
  }
}

/** Remember the space and reopen the app in it (its manifest and progress differ). */
export function openSpace(id) {
  try {
    localStorage.setItem(STORE_KEY, id);
  } catch { /* private mode: the switch lasts for this visit only */ }
  location.hash = "#/";
  location.reload();
}

const spaceOf = (e) => e.payload?.space ?? CFA;

/** Does this event belong to the space? Settings are shared except the study-plan ones. */
export function inSpace(e, space = current) {
  if (e.type === "setting") return !SPACE_KEYS.has(e.payload?.key) || spaceOf(e) === space;
  if (e.type.startsWith("l1")) return space === CFA; // CFA Level I practice
  return spaceOf(e) === space;
}

/** The payload to log: stamped with the space outside CFA (CFA events stay as they always were). */
export function stamp(type, payload, space = current) {
  if (space === CFA || (type === "setting" && !SPACE_KEYS.has(payload.key))) return payload;
  return { ...payload, space };
}

/** A per-device storage key (mock in progress, last module read) for the current space. */
export const spaceKey = (name) => (current === CFA ? name : `${current}:${name}`);

// ---------------------------------------------------------------- exam format

const CFA2 = { name: "CFA Level II", short: "CFA II", options: 3, mock: { questions: 88, sessions: 2, minutes: 264, standalone: false } };
let examInfo = CFA2;

/** The current exam's name, option count and mock format (manifest.exam; CFA Level II by default). */
export const exam = () => examInfo;
export const setExam = (info) => { examInfo = info ? { ...CFA2, ...info, mock: { ...CFA2.mock, ...info.mock } } : CFA2; };

/** What the books call a learning outcome: "LOS" (CFA) or "LO" (FRM). */
export const losWord = () => examInfo.los ?? "LOS";

/** Answer letters for a question: A-C, or A-D on four-option exams. */
export const lettersFor = (q) => ["A", "B", "C", "D"].slice(0, Math.max(3, q?.options?.length ?? examInfo.options));

/** Time per question at exam pace (CFA Level II: 3 min; FRM Part I: 2.4 min). */
export const paceMs = () => (examInfo.mock.minutes * 60_000) / examInfo.mock.questions;

/** Everything the exam switch offers: CFA Level I (if built), CFA Level II, then the other spaces. */
export function examChoices(main) {
  return [
    ...(main?.level1 ? [{ space: CFA, level: 1, label: "CFA I" }] : []),
    { space: CFA, level: 2, label: "CFA II" },
    ...(main?.spaces ?? []).map((s) => ({ space: s.id, label: s.short ?? s.name })),
  ];
}
