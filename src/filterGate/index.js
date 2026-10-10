// FG-1: the Filter Gate public API.
//
// checkMany(profile, type, candidates, deps) -> Map<key, { verdict, reason, detail, source }>
// check(profile, type, candidate, deps) -> one result
// filterHash(filters, type, nowYear) -> short stable hash
const crypto = require('crypto');
const { compileRules } = require('./rules');
const { resolveFacts } = require('./data');
const store = require('./store');

// A short stable hash of the active filter parameters. Changing any of
// minRating, minYear, voteFloor, or excluded_genres changes the hash, so old
// verdicts are never reused for new filters.
function filterHash(filters, type, nowYear) {
  const f = filters || {};
  const minRating = f.min_rating || 0;
  const minYear = require('../recency').minYearOf(f, nowYear);
  const voteFloor = require('../services/tmdb').voteFloor(f, type);
  const excluded = (f.excluded_genres || []).slice().sort();
  const input = JSON.stringify({ minRating, minYear, voteFloor, excluded });
  return crypto.createHash('sha1').update(input).digest('hex').slice(0, 12);
}

async function checkMany(profile, type, candidates, deps = {}) {
  const log = deps.log || console;
  const now = deps.now || Date.now;
  const nowYear = new Date(now()).getFullYear();

  const { needs, evaluate } = compileRules(profile.filters, type, { nowYear });

  // Empty needs => all good, no fetches, no table access.
  if (needs.size === 0) {
    const out = new Map();
    for (const c of candidates) {
      out.set(c.key, { verdict: 'good', reason: null, detail: null, source: 'rules' });
    }
    return out;
  }

  const fhash = filterHash(profile.filters, type, nowYear);
  const keys = candidates.map((c) => c.key);

  // Read stored verdicts.
  const stored = store.getVerdicts(profile.id, type, fhash, keys, now());
  const results = new Map();
  const toResolve = [];
  for (const c of candidates) {
    const sv = stored.get(c.key);
    if (sv) {
      results.set(c.key, { verdict: sv.verdict, reason: sv.reason, detail: sv.detail, source: sv.source });
    } else {
      toResolve.push(c);
    }
  }

  // Resolve facts only for the rest.
  if (toResolve.length) {
    const facts = await resolveFacts(profile, type, toResolve, needs, deps);
    for (const c of toResolve) {
      const f = facts.get(c.key);
      const evalResult = evaluate(f || {});
      const result = {
        verdict: evalResult.ok ? 'good' : 'bad',
        reason: evalResult.ok ? null : evalResult.reason,
        detail: evalResult.ok ? null : evalResult.detail,
        source: f?.source || 'rules',
      };
      results.set(c.key, result);
      // Store (except no_data bad).
      store.recordVerdict(
        profile.id, type, c.key, fhash,
        result.verdict, result.reason, result.detail, result.source, now()
      );
    }
  }

  return results;
}

async function check(profile, type, candidate, deps = {}) {
  const map = await checkMany(profile, type, [candidate], deps);
  return map.get(candidate.key);
}

module.exports = { checkMany, check, filterHash };
