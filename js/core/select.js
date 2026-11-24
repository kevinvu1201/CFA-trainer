// Choosing what to practise next. (Phase 6 replaces this with priority + spaced repetition.)

/** Latest answer event per question id. */
export function lastAnswers(ans) {
  const last = new Map();
  for (const e of ans) {
    const prev = last.get(e.payload.qid);
    if (!prev || e.ts >= prev.ts) last.set(e.payload.qid, e);
  }
  return last;
}

/** Unseen questions first, then ones last answered wrongly, then the rest; random within each tier. */
export function pickQuestions(pool, ans, n, rng = Math.random) {
  const last = lastAnswers(ans);
  const tier = (q) => {
    const e = last.get(q.id);
    return !e ? 0 : e.payload.correct ? 2 : 1;
  };
  return pool
    .map((q) => ({ q, score: tier(q) + rng() }))
    .sort((a, b) => a.score - b.score)
    .slice(0, n)
    .map((x) => x.q);
}

/** An item set the user hasn't attempted, else the one attempted longest ago. */
export function pickItemSet(sets, ans, rng = Math.random) {
  if (!sets.length) return null;
  const lastTs = new Map();
  for (const e of ans) if (e.payload.set) lastTs.set(e.payload.set, Math.max(lastTs.get(e.payload.set) ?? 0, e.ts));
  return sets
    .map((s) => ({ s, score: (lastTs.get(s.id) ?? -1) + rng() }))
    .sort((a, b) => a.score - b.score)[0].s;
}

export const MODULE_MIN = 10; // a module with fewer questions of its own is topped up...
export const MODULE_FILL = 15; // ...to this many, from its neighbours

const usable = (q) => q.options?.length && q.answer;

/**
 * A module's drill pool: the questions written for it (its Schweser quiz and the generated ones
 * authored with it). A module with fewer than MODULE_MIN of its own is topped up to MODULE_FILL
 * with questions from the nearest other modules that cover the same learning outcomes.
 */
export function modulePool(chunk, moduleId) {
  const own = chunk.questions.filter((q) => usable(q) && q.module === moduleId);
  if (own.length >= MODULE_MIN) return { own, related: [] };
  const los = new Set(chunk.los.filter((l) => l.modules.includes(moduleId)).map((l) => l.id));
  const order = new Map(chunk.modules.map((m, i) => [m.id, i]));
  const at = order.get(moduleId) ?? 0;
  const gap = (q) => Math.abs((order.get(q.module) ?? 1e6) - at);
  const related = chunk.questions
    .filter((q) => usable(q) && q.module !== moduleId && [q.los].flat().some((l) => los.has(l)))
    .sort((a, b) => gap(a) - gap(b) || a.id.localeCompare(b.id))
    .slice(0, MODULE_FILL - own.length);
  return { own, related };
}

/** Usable questions for a topic, or for one module (its own, then related), excluding item-set questions. */
export function questionPool(chunk, moduleId = null) {
  if (moduleId) {
    const { own, related } = modulePool(chunk, moduleId);
    return [...own, ...related];
  }
  return chunk.questions.filter(usable);
}

/** n questions for a module drill: its own first (unseen, then missed), related ones only to fill up. */
export function pickModuleQuestions(chunk, moduleId, ans, n, rng = Math.random) {
  const { own, related } = modulePool(chunk, moduleId);
  const picked = pickQuestions(own, ans, n, rng).map((q) => ({ q, related: false }));
  return picked.length >= n ? picked : [...picked, ...pickQuestions(related, ans, n - picked.length, rng).map((q) => ({ q, related: true }))];
}

/** Normalised facts about a question, whichever source it comes from. */
export function questionMeta(q, chunk) {
  const los = [q.los].flat().filter(Boolean);
  const home = chunk.los.find((l) => l.id === los[0]);
  return { los, module: q.module ?? home?.module ?? null };
}
