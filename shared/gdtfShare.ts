// Matching a fixture LIGHT is missing against the GDTF Share catalogue.
//
// This is deliberately a pure module with no network in it: the HTTP lives in
// src-tauri (light-core has no TLS stack and the crate that drives DMX is not
// where a web client belongs), and the matching is testable offline against a
// slice of a real catalogue response.
//
// WHY RANKING RATHER THAN LOOKUP. An MVR names a fixture as
// `Manufacturer@Fixture@rNNNN.gdtf`. It is tempting to read that as a key. It is
// not one — checked against a real festival MVR and a real 12,436-entry
// catalogue response:
//
//   MVR `Robe@Robin Spiider@r3045`   -> Share "Robe Lighting" / "Robin Spiider"
//   MVR `Acme@Lyra@r3006`            -> Share "ACME" / "ACME LYRA(XA 1000 BSWF IP)"
//   MVR `Ayrton@Rivale Profile@r3014`-> two exact hits, plus a decoy from "LPL"
//
// Two of three fail on exact manufacturer+fixture. `r3045` is not the `rid`
// (rids run 346..156360). And "robe" alone matches four different manufacturers.
// So: score, shortlist, and let the operator confirm. Never auto-download —
// silently patching the wrong fixture is worse than not finding it.

/** One catalogue entry, as `getList.php` actually returns it. */
export type ShareEntry = {
  rid: number;
  fixture: string;
  manufacturer: string;
  revision: string | null;
  creator: string | null;
  uploader: string | null;
  description: string | null;
  creationDate: number;
  lastModified: number;
  rating: string | null;
  /** GDTF spec version of the file, e.g. "1.2" — NOT an API version */
  version: string;
  uuid: string;
  modes: { name: string; dmxfootprint: number }[];
  filesize: number;
};

export type ShareList = { result: boolean; list: ShareEntry[] };

/** What we know about the fixture we are missing. */
export type MissingFixture = {
  /** manufacturer as the source named it, e.g. "Robe" */
  manufacturer?: string;
  /** model as the source named it, e.g. "Robin Spiider" */
  model?: string;
};

export type ShareMatch = { entry: ShareEntry; score: number };

/** Words, lowercased, punctuation dropped. "ACME LYRA(XA 1000 BSWF IP)" ->
 *  [acme, lyra, xa, 1000, bswf, ip]. Keeps digits: "1000" distinguishes real
 *  models, and dropping it would collapse a product line into one blur. */
export function tokens(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter(Boolean);
}

/** Parse an MVR `GDTFSpec` into the parts worth matching on.
 *
 *  The trailing `@rNNNN` is a revision marker in the FILE name and does not
 *  correspond to anything the API returns, so it is discarded rather than
 *  matched — matching on it produces confident wrong answers. */
export function parseGdtfSpec(spec: string): MissingFixture {
  const bare = spec.replace(/\.gdtf$/i, '');
  const parts = bare.split('@');
  if (parts.length >= 2) {
    const manufacturer = parts[0];
    // drop a trailing rNNNN segment; keep everything else as the model
    const rest = parts.slice(1).filter((p) => !/^r\d+$/i.test(p));
    return { manufacturer, model: rest.join(' ') || undefined };
  }
  return { model: bare || undefined };
}

/** How well one catalogue entry answers what we are missing, 0..1.
 *
 *  Model similarity dominates. A manufacturer is a weak signal — "Robe" and
 *  "Robe Lighting" are the same company, and four Share manufacturers contain
 *  "robe" — so it breaks ties rather than deciding them. That asymmetry is the
 *  whole reason "ACME LYRA(XA 1000 BSWF IP)" can win for a query of "Lyra".
 */
export function scoreEntry(want: MissingFixture, e: ShareEntry): number {
  const overlap = (a: string[], b: string[]): number => {
    if (a.length === 0 || b.length === 0) return 0;
    const bs = new Set(b);
    const hit = a.filter((t) => bs.has(t)).length;
    // fraction of the QUERY matched, so a long catalogue name is not punished
    // for carrying extra words the operator did not type
    return hit / a.length;
  };

  const wantModel = tokens(want.model ?? '');
  const wantMan = tokens(want.manufacturer ?? '');
  // the catalogue often repeats the brand inside the model, so match the query
  // model against both fields together
  const haveModel = tokens(`${e.fixture} ${e.manufacturer}`);
  const haveMan = tokens(e.manufacturer);

  let score = overlap(wantModel, haveModel) * 0.75 + overlap(wantMan, haveMan) * 0.25;

  // exact model string is worth a nudge above a token-equal near miss
  if (want.model && e.fixture.toLowerCase() === want.model.toLowerCase()) score += 0.12;
  // prefer entries that are actually usable
  if (e.modes.length === 0) score -= 0.3;

  return Math.max(0, Math.min(1, score));
}

/** The shortlist to put in front of the operator, best first.
 *
 *  `limit` is small on purpose: this sits beside a "fixture not found" warning,
 *  and a list long enough to scroll is a list nobody reads. */
export function rankMatches(
  want: MissingFixture,
  list: ShareEntry[],
  limit = 8,
): ShareMatch[] {
  const scored = list
    .map((entry) => ({ entry, score: scoreEntry(want, entry) }))
    .filter((m) => m.score > 0.25)
    .sort(
      (a, b) =>
        b.score - a.score ||
        // same score: newest revision first, then the smaller download
        b.entry.lastModified - a.entry.lastModified ||
        a.entry.filesize - b.entry.filesize,
    );
  return scored.slice(0, limit);
}

/** A catalogue response we are willing to replace the cache with.
 *
 *  In October 2025 the live API returned a success-shaped EMPTY list for a day.
 *  A cache that trusts that wipes the operator's fixture library on a refresh,
 *  so: never accept empty, and never accept a list that has collapsed. The
 *  catalogue only grows in practice — it was ~5,600 devices in April 2025 and
 *  ~9,365 by July 2026. */
export function isAcceptableList(next: ShareList | null, previousCount: number): boolean {
  if (!next || next.result !== true || !Array.isArray(next.list)) return false;
  if (next.list.length === 0) return false;
  // allow a little shrinkage for withdrawn entries, refuse a collapse
  if (previousCount > 0 && next.list.length < previousCount * 0.75) return false;
  return true;
}
