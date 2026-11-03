// French content: each English content string is looked up by its hash in the topic's French
// strings (built by builder/i18n.py). Only content views translate; practice questions don't call
// this, so they stay in English. Anything without a translation falls back to the English.

import { useEffect, useMemo, useState } from "../lib.js";
import { frenchNow, getFrench, topicInfo } from "./data.js";
import { useEvents } from "./events.js";
import { settingsFrom } from "./settings.js";

/** cyrb53 over UTF-16 code units, base 36: identical to text_hash() in builder/i18n.py. */
export function hashText(str) {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

export const identity = (s) => s;

/** "fr" or "en", from the synced settings. */
export function useContentLang() {
  const events = useEvents();
  return events ? settingsFrom(events).content_lang : "en";
}

/**
 * A t(text) function for a topic's content: the French version when French is chosen and
 * available, otherwise the text unchanged. Re-renders once the French strings have loaded.
 */
export function useTranslator(topicId) {
  const want = useContentLang() === "fr" && Boolean(topicInfo(topicId)?.fr);
  const [dict, setDict] = useState(() => (want ? frenchNow(topicId) : null));
  useEffect(() => {
    if (!want) return setDict(null);
    let live = true;
    getFrench(topicId).then((d) => live && setDict(d), () => {});
    return () => { live = false; };
  }, [topicId, want]);
  return useMemo(() => {
    if (!want || !dict) return identity;
    return (s) => (s && dict[hashText(s)]) || s;
  }, [want, dict]);
}

