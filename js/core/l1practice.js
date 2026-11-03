// Level I quick practice: random questions from the whole pool, plus the game layer (daily goal,
// streak, combo, XP, confidence bets, mystery chests). Everything is derived from the event log
// ("l1practice" answers, "l1flag" flags, "l1reward" chests), so it syncs and survives reinstalling.
//
// Rounds: a question answered once doesn't come back until every question in the pool has been
// answered; then a new round starts. Wrong answers are the exception: they come back later in the
// same session and on later days until answered correctly twice in a row.

import { localDay } from "./analytics.js";

const DAY = 86_400_000;
export const BETS = { 1: { label: "Guess", stake: 10, mult: 1.2 }, 2: { label: "Unsure", stake: 25, mult: 1.5 }, 3: { label: "Sure", stake: 50, mult: 2 } };
export const CHEST_EVERY = 10; // correct answers per mystery chest
const BOOST_ANSWERS = 10; // a "double XP" prize lasts this many answers
const CLEAR_AFTER = 2; // correct answers in a row that take a question off the wrong list

const answersOf = (events) => events.filter((e) => e.type === "l1practice");

/** Questions currently flagged as unsure (latest flag event per question wins). */
export function flaggedSet(events) {
  const out = new Set();
  for (const e of events) {
    if (e.type !== "l1flag") continue;
    if (e.payload.flagged) out.add(e.payload.qid);
    else out.delete(e.payload.qid);
  }
  return out;
}

/**
 * Practice state over the pool: the round, what's been answered this round, the latest answer to
 * every question, and the wrong list (missed, and not yet answered right twice in a row since).
 */
export function practiceState(events, pool) {
  const inPool = new Set(pool);
  const latest = new Map(); // qid -> {correct, choice, ts}
  const run = new Map(); // qid -> correct answers in a row since the last miss (-1: never missed)
  let seen = new Set();
  let round = 1;
  let answers = 0;
  let correct = 0;
  for (const e of answersOf(events)) {
    const { qid } = e.payload;
    latest.set(qid, { correct: e.payload.correct, choice: e.payload.choice, ts: e.ts });
    run.set(qid, e.payload.correct ? (run.get(qid) ?? -1) < 0 ? -1 : run.get(qid) + 1 : 0);
    answers += 1;
    if (e.payload.correct) correct += 1;
    if (!inPool.has(qid)) continue;
    seen.add(qid);
    if (seen.size === inPool.size) {
      round += 1;
      seen = new Set();
    }
  }
  const wrong = [...run].filter(([qid, r]) => r >= 0 && r < CLEAR_AFTER && inPool.has(qid)).map(([qid]) => qid);
  return { round, seen, remaining: pool.filter((q) => !seen.has(q)), latest, wrong, answers, correct };
}

/** Answers given in one practice sitting, in order. */
export const sessionAnswers = (events, session) =>
  answersOf(events).filter((e) => e.payload.session === session).map((e) => e.payload);

/** A stable number in [0, 1) from a string (cyrb-style hash). */
export function unit(seed) {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619);
  h = Math.imul(h ^ (h >>> 15), 2246822507);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** How many answers after a miss it comes back in the same session (5 to 8). */
export const comebackDelay = (qid, session) => 5 + Math.floor(unit(`${qid}|${session}`) * 4);

/** A question missed earlier in this session whose comeback is due, if any. */
export function dueComeback(answered) {
  const last = new Map();
  answered.forEach((a, i) => last.set(a.qid, { ...a, i }));
  for (const a of last.values()) {
    if (!a.correct && answered.length - 1 - a.i >= comebackDelay(a.qid, a.session ?? "")) return a.qid;
  }
  return null;
}

/**
 * The next question for a mode: "pool" draws from what's left this round, "wrong" and "flagged"
 * from those lists. A due comeback always wins; in pool mode about 1 in 5 picks is a wrong answer
 * from an earlier day, so mistakes resurface without a separate review step.
 */
export function nextQuestion(mode, state, flagged, done, random = Math.random, answered = []) {
  const back = dueComeback(answered);
  if (back) return back;
  const today = localDay(Date.now());
  if (mode === "pool") {
    const old = state.wrong.filter((q) => !done.has(q) && localDay(state.latest.get(q)?.ts ?? 0) !== today);
    if (old.length && random() < 0.2) return old[Math.floor(random() * old.length)];
  }
  const source = mode === "wrong" ? state.wrong : mode === "flagged" ? [...flagged] : state.remaining;
  const fresh = source.filter((q) => !done.has(q));
  const from = mode === "pool" && !fresh.length ? source : fresh;
  return from.length ? from[Math.floor(random() * from.length)] : null;
}

// ---------------------------------------------------------------- goal, streak, progress

/** Practice answers per local day. */
export function dailyCounts(events) {
  const out = new Map();
  for (const e of answersOf(events)) out.set(localDay(e.ts), (out.get(localDay(e.ts)) ?? 0) + 1);
  return out;
}

const dayShift = (ts, n) => { const d = new Date(ts); return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n).getTime(); };

/**
 * Consecutive days with the goal met, ending today (today counts once met; until then the streak
 * runs to yesterday). A missed day is forgiven if the next day hit twice the goal, or if a streak
 * freeze token from a chest is left.
 */
export function goalStreak(events, goal, now = Date.now()) {
  const counts = dailyCounts(events);
  let freezes = rewardsOf(events).filter((r) => r.prize === "freeze").length;
  const met = (ts) => (counts.get(localDay(ts)) ?? 0) >= goal;
  let streak = met(now) ? 1 : 0;
  let day = dayShift(now, -1);
  for (let guard = 0; guard < 3650; guard++) {
    if (met(day)) { streak += 1; day = dayShift(day, -1); continue; }
    const after = counts.get(localDay(dayShift(day, 1))) ?? 0;
    const anyBefore = [...counts.keys()].some((k) => k < localDay(day));
    if (!anyBefore) break;
    if (after >= 2 * goal) { day = dayShift(day, -1); continue; }
    if (freezes > 0) { freezes -= 1; day = dayShift(day, -1); continue; }
    break;
  }
  return streak;
}

/** This week, Monday to Sunday: answers per day and whether the goal was met. */
export function weekDots(events, goal, now = Date.now()) {
  const counts = dailyCounts(events);
  const monday = dayShift(now, -((new Date(now).getDay() + 6) % 7));
  return ["M", "T", "W", "T", "F", "S", "S"].map((label, i) => {
    const ts = dayShift(monday, i);
    const n = counts.get(localDay(ts)) ?? 0;
    return { label, n, met: n >= goal, today: localDay(ts) === localDay(now), future: ts > now };
  });
}

/** Per topic: questions in the pool, how many answered at least once, and latest-answer accuracy. */
export function topicProgress(events, data) {
  const latest = practiceState(events, data.pool).latest;
  const rows = new Map(Object.keys(data.topics).map((t) => [t, { topic: t, total: 0, answered: 0, right: 0 }]));
  for (const qid of data.pool) {
    const row = rows.get(data.questions[qid].topic);
    row.total += 1;
    const a = latest.get(qid);
    if (a) { row.answered += 1; if (a.correct) row.right += 1; }
  }
  return [...rows.values()].filter((r) => r.total);
}

/** Best session accuracy (10+ answers), longest combo, most answers in a day. */
export function personalBests(events) {
  const sessions = new Map();
  let combo = 0;
  let bestCombo = 0;
  let lastSession = null;
  for (const e of answersOf(events)) {
    const s = e.payload.session ?? "";
    if (s !== lastSession) combo = 0;
    lastSession = s;
    combo = e.payload.correct ? combo + 1 : 0;
    bestCombo = Math.max(bestCombo, combo);
    const t = sessions.get(s) ?? { n: 0, right: 0 };
    t.n += 1; t.right += e.payload.correct ? 1 : 0;
    sessions.set(s, t);
  }
  const accs = [...sessions.values()].filter((t) => t.n >= 10).map((t) => t.right / t.n);
  return { bestAccuracy: accs.length ? Math.max(...accs) : null, bestCombo, bestDay: Math.max(0, ...dailyCounts(events).values()) };
}

/** Correct answers in a row at the end of a sitting. */
export function comboOf(answered) {
  let n = 0;
  for (let i = answered.length - 1; i >= 0 && answered[i].correct; i--) n += 1;
  return n;
}

// ---------------------------------------------------------------- XP, bets, chests

function rewardsOf(events) {
  return events.filter((e) => e.type === "l1reward").map((e) => ({ ...e.payload, ts: e.ts }));
}

/** XP balance: every answer's payout plus chest prizes, never below zero along the way. */
export function xpBalance(events) {
  let xp = 0;
  for (const e of events) {
    if (e.type === "l1practice") xp = Math.max(0, xp + (e.payload.payout ?? (e.payload.correct ? 10 : 0)));
    else if (e.type === "l1reward") xp = Math.max(0, xp + (e.payload.xp ?? 0));
  }
  return xp;
}

/** Answers still covered by a "double XP" chest prize. */
export function boostLeft(events) {
  let left = 0;
  for (const e of events) {
    if (e.type === "l1reward" && e.payload.prize === "double") left = BOOST_ANSWERS;
    else if (e.type === "l1practice" && left > 0) left -= 1;
  }
  return left;
}

/**
 * XP for one answer. Base 10 for a right answer (+5 for fixing an earlier miss), combo bonuses at
 * every 5th and 10th in a row, and the bet: a win pays stake × multiplier, a loss costs the stake.
 */
export function settleAnswer({ correct, conf, retry = false, combo = 0, boost = false }) {
  let xp = correct ? 10 + (retry ? 5 : 0) : 0;
  if (correct && combo > 0 && combo % 10 === 0) xp += 50;
  else if (correct && combo > 0 && combo % 5 === 0) xp += 20;
  const bet = BETS[conf];
  if (bet) xp += correct ? Math.round(bet.stake * bet.mult) : -bet.stake;
  if (boost && xp > 0) xp *= 2;
  return xp;
}

/** Chests earned (one per CHEST_EVERY correct answers) and not yet opened, with each one's seed. */
export function pendingChests(events) {
  const seeds = [];
  let correct = 0;
  for (const e of answersOf(events)) {
    if (!e.payload.correct) continue;
    correct += 1;
    if (correct % CHEST_EVERY === 0) seeds.push(e.id); // the 10th answer's random id seeds the chest
  }
  const opened = rewardsOf(events).filter((r) => r.kind === "chest").length;
  return seeds.slice(opened);
}

/** What's in a chest: 70% 20–50 XP, 25% rare (150 XP or double XP), 5% jackpot (500 XP or a streak freeze). */
export function openChest(seed) {
  const r = unit(`chest|${seed}`);
  const s = unit(`pick|${seed}`);
  if (r < 0.7) return { tier: "common", prize: "xp", xp: 20 + Math.floor(s * 31) };
  if (r < 0.95) return s < 0.5 ? { tier: "rare", prize: "xp", xp: 150 } : { tier: "rare", prize: "double", xp: 0 };
  return s < 0.5 ? { tier: "jackpot", prize: "xp", xp: 500 } : { tier: "jackpot", prize: "freeze", xp: 0 };
}

/** Bet results: how often each confidence level was right (calibration). */
export function betRecord(events) {
  const out = Object.fromEntries(Object.keys(BETS).map((k) => [k, { n: 0, right: 0 }]));
  for (const e of answersOf(events)) {
    const r = out[e.payload.conf];
    if (r) { r.n += 1; r.right += e.payload.correct ? 1 : 0; }
  }
  return out;
}

export const daysAgo = (ts, now = Date.now()) => Math.round((now - ts) / DAY);
