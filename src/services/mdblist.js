// MDBList (mdblist.com) — sole source for Common Sense Media age ratings.
// STRICT by design: kids/age-limited profiles only list titles that HAVE a
// Common Sense rating at or below the limit. No rating -> not listed. We do
// not fall back to MPAA/TMDB certifications or any other source.
const { USER_AGENT } = require('./trakt');

const NOT_RATED = null;

function parseCommonSenseAge(data) {
  // Field observed as `commonsense` (number, or string like "10+"); some
  // responses carry it in the ratings array instead. Both are CSM data.
  const direct = data?.commonsense;
  if (direct !== undefined && direct !== null && direct !== '') {
    const n = parseInt(String(direct), 10);
    if (!Number.isNaN(n)) return n;
  }
  const entry = (data?.ratings || []).find(
    (r) => r.source === 'commonsense' || r.source === 'common_sense' || r.source === 'commonsensemedia'
  );
  if (entry && entry.value !== undefined && entry.value !== null && entry.value !== '') {
    const n = parseInt(String(entry.value), 10);
    if (!Number.isNaN(n)) return n;
  }
  return NOT_RATED;
}

async function fetchJson(url) {
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
  if (!res.ok) {
    const err = new Error(`MDBList request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

// Returns the Common Sense age (number) or null if CSM has not rated it.
// Throws on transport/auth errors so callers can distinguish "not rated"
// (drop the title) from "lookup broken" (fail the rebuild, keep old list).
async function commonSenseAge(apiKey, type, imdbId) {
  const mediaType = type === 'series' ? 'show' : 'movie';
  try {
    const data = await fetchJson(
      `https://api.mdblist.com/imdb/${mediaType}/${encodeURIComponent(imdbId)}?apikey=${encodeURIComponent(apiKey)}`
    );
    return parseCommonSenseAge(data);
  } catch (err) {
    if (err.status && err.status !== 404) throw err; // auth/rate-limit/etc.
    // 404 on the modern endpoint or older deployments: try the legacy API
    const data = await fetchJson(
      `https://mdblist.com/api/?apikey=${encodeURIComponent(apiKey)}&i=${encodeURIComponent(imdbId)}`
    );
    return parseCommonSenseAge(data);
  }
}

// Look up many titles with limited concurrency (free tier: 1000 req/day —
// a rebuild touches a few dozen, so the budget is fine).
async function commonSenseAges(apiKey, type, imdbIds, log = console) {
  const results = new Map();
  const queue = [...imdbIds];
  const workers = Array.from({ length: 5 }, async () => {
    while (queue.length) {
      const id = queue.shift();
      try {
        results.set(id, await commonSenseAge(apiKey, type, id));
      } catch (err) {
        log.error(`[mdblist] lookup ${id} failed: ${err.message}`);
        throw err; // abort — an unverifiable list must not be served
      }
    }
  });
  await Promise.all(workers);
  return results;
}

async function testKey(apiKey) {
  // A title guaranteed to exist; validates the key end-to-end.
  const age = await commonSenseAge(apiKey, 'movie', 'tt0111161');
  return { valid: true, sampleAge: age };
}

module.exports = { commonSenseAge, commonSenseAges, parseCommonSenseAge, testKey };
