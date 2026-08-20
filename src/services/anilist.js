// AniList fallback for anime adult signals when MAL/Jikan is down (v6.26).
//
// Queried by the SAME MAL id (`idMal`) the anime map already hands us, so it
// slots in directly behind Jikan with no new id mapping — see mal.ratings.
//
// WHAT ANILIST CAN AND CANNOT TELL US — do not confuse the two:
//   * isAdult / a Hentai|Erotica genre -> the terminal NSFW blacklist. Reliable,
//     and terminal for EVERY profile, so it is the signal worth rescuing.
//   * There is NO age-classification band. AniList has no equivalent of MAL's
//     G/PG/PG-13/R/R+/Rx, so a NON-adult AniList verdict carries minAge=null:
//     "not blocked, no age band" -> the title falls through to the LLM, exactly
//     as an unrated title does. AniList rescues the blacklist, not the age band.
const governor = require('./governor');

const API = 'https://graphql.anilist.co';
const ADULT_GENRES = /^(hentai|erotica)$/i;
// Minimal query — only the fields that feed a verdict. Adult flag + genres.
const QUERY = 'query($id:Int){Media(idMal:$id,type:ANIME){isAdult genres}}';
const REQUEST_TIMEOUT_MS = 10000;

const UNRATED = () => ({ code: null, minAge: null, adult: false, adultish: false });

// Map an AniList Media node into our verdict shape. Pure, for testability.
// Adult -> mirror MAL's Rx tier so downstream logging/handling is identical.
// Everything else -> unrated (minAge null), which means "LLM decides".
function parseMedia(media) {
  if (!media) return null;
  const genres = media.genres || [];
  const adult = media.isAdult === true || genres.some((g) => ADULT_GENRES.test(g));
  return adult
    ? { code: 'Rx', minAge: 99, adult: true, adultish: false }
    : UNRATED();
}

// Verdict for one MAL id via AniList, or throws. Same contract as
// mal.fetchRating so mal.ratings can treat the two interchangeably.
async function fetchRating(malId) {
  const res = await governor.schedule('anilist', () => fetch(API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ query: QUERY, variables: { id: Number(malId) } }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  }));
  if (res.status === 404) return UNRATED();
  if (!res.ok) {
    const err = new Error(`AniList idMal/${malId} failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  const body = await res.json().catch(() => null);
  const media = body?.data?.Media;
  if (media) return parseMedia(media);
  // AniList reports "not in the database" as a 200 with a 404 in errors[] and
  // a null Media. That is a definitive "no record", not a failure -> unrated.
  if ((body?.errors || []).some((e) => e?.status === 404)) return UNRATED();
  const err = new Error(`AniList idMal/${malId}: no Media in response`);
  throw err;
}

module.exports = { fetchRating, parseMedia };
