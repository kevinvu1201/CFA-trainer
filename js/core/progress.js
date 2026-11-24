// Study progress for the Level II subject and module lists: how much has been read (modules marked
// finished) and practised (questions answered, by their latest result). All derived from events.

import { answers } from "./analytics.js";
import { finishedModules } from "./plan.js";
import { lastAnswers, modulePool } from "./select.js";

/** Latest result per question id: true (right) or false (wrong). */
export function latestResults(events) {
  const out = new Map();
  for (const [qid, e] of lastAnswers(answers(events))) out.set(qid, e.payload.correct);
  return out;
}

/** {right, wrong, total} for a list of question ids. */
export function tally(ids, results) {
  let right = 0;
  let wrong = 0;
  for (const id of ids) {
    const r = results.get(id);
    if (r === true) right += 1;
    else if (r === false) wrong += 1;
  }
  return { right, wrong, total: ids.length };
}

/** A module's practice progress over its own questions (its related ones if it has none). */
export function moduleTally(chunk, moduleId, results) {
  const { own, related } = modulePool(chunk, moduleId);
  return tally((own.length ? own : related).map((q) => q.id), results);
}

/**
 * A subject's practice progress without loading its content: distinct questions of the topic
 * answered (item-set questions aside), against the topic's count of practice questions.
 */
export function topicTally(topic, events, results) {
  const seen = new Set();
  for (const e of answers(events)) {
    if (e.payload.topic === topic.id && !String(e.payload.qid).startsWith("set.")) seen.add(e.payload.qid);
  }
  const t = tally([...seen], results);
  return { ...t, total: Math.max(topic.counts.practice ?? topic.counts.questions, seen.size) };
}

/** Modules of a topic (or one reading) marked finished. */
export function readTally(modules, finished) {
  return { read: modules.filter((m) => finished.has(m.id)).length, total: modules.length };
}

export const topicModules = (topic) => topic.readings.flatMap((r) => r.modules);
export { finishedModules };
