/**
 * Label matching used to re-resolve historical products against today's
 * catalogue. Product ids drift over time; labels drift less, so when an id is
 * unknown we look the product up by label and accept an exact normalized match
 * or a close token-overlap match.
 */

/** Lowercase, strip accents and punctuation, collapse whitespace. */
export function normalizeLabel(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&[a-z#0-9]+;/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function tokens(s: string): Set<string> {
  return new Set(normalizeLabel(s).split(" ").filter((t) => t.length > 1));
}

/** Jaccard similarity of token sets, in [0, 1]. */
export function labelSimilarity(a: string, b: string): number {
  const ta = tokens(a);
  const tb = tokens(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  return inter / (ta.size + tb.size - inter);
}

export interface LabelMatch<T> {
  item: T;
  kind: "label_exact" | "label_fuzzy";
  score: number;
}

/** Accept a fuzzy match only above this token overlap. */
export const FUZZY_THRESHOLD = 0.7;

/**
 * Tokens carrying a quantity/format ("250g", "6x1l", "x12", "1p"). Two labels
 * describing the same product must agree on them: "Ketchup 250g" vs "Ketchup
 * 342g" is a different reference, however close the words are.
 */
export function formatTokens(s: string): Set<string> {
  return new Set([...tokens(s)].filter((t) => /\d/.test(t)));
}

function sameFormat(a: string, b: string): boolean {
  const fa = formatTokens(a);
  const fb = formatTokens(b);
  if (fa.size !== fb.size) return false;
  for (const t of fa) if (!fb.has(t)) return false;
  return true;
}

/** Best candidate by label; undefined when nothing is close enough. */
export function bestLabelMatch<T>(
  label: string,
  candidates: T[],
  labelOf: (c: T) => string,
): LabelMatch<T> | undefined {
  const target = normalizeLabel(label);
  let best: LabelMatch<T> | undefined;
  for (const c of candidates) {
    const cl = labelOf(c);
    if (normalizeLabel(cl) === target) return { item: c, kind: "label_exact", score: 1 };
    if (!sameFormat(label, cl)) continue;
    const score = labelSimilarity(label, cl);
    if (score >= FUZZY_THRESHOLD && (!best || score > best.score)) {
      best = { item: c, kind: "label_fuzzy", score };
    }
  }
  return best;
}
