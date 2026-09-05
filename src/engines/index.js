// Engine registry (SC-01). Register engines here; the per-type helpers power the
// UI dropdowns (cards 04/05) and the build/serve resolution (card 03). With a
// single engine, listForType(type) returns [genesis] for both types → a single,
// locked option, and everyone keeps today's results (a user-visible no-op until
// a second engine is registered).
const genesis = require('./genesis');

const REGISTRY = new Map([[genesis.id, genesis]]);
const DEFAULT_ID = 'genesis';

function get(id) { return REGISTRY.get(id) || null; }
function list() { return [...REGISTRY.values()]; }
function listForType(t) { return list().filter((e) => e.supportedTypes.includes(t)); }
function has(id) { return REGISTRY.has(id); }

// Test-only hook (used by card 06's conformance/second-engine fixtures) to
// register a stub engine and get a disposer. NOT part of the runtime surface.
function _register(engine) {
  REGISTRY.set(engine.id, engine);
  return () => REGISTRY.delete(engine.id);
}

// availableFor: the engines this profile may CHOOSE for `type` — listForType
// minus any `unrestricted` ("all ages"/fully open) engine when the profile has
// an age limit (I7 / overview §5.5). Powers the dropdowns (portal + companion)
// so an open engine is never offered to an age-gated profile. Genesis
// (unrestricted:false) is always in the result, so a dropdown is never empty.
function availableFor(profile, type) {
  const limited = (profile?.filters?.age_limit || 0) > 0;
  return listForType(type).filter((e) => !(limited && e.capabilities.unrestricted));
}

// resolveFor: the effective engine for (profile, type). Falls back to Genesis
// (the guaranteed safe floor) when the stored id is unknown, doesn't support the
// type, OR is an unrestricted engine on an age-limited profile — so even a
// hand-edited profiles.json can never serve open content to a kids profile (I7).
function resolveFor(profile, type) {
  const id = profile?.filters?.[`engine_${type}`];
  const e = get(id);
  if (!e || !e.supportedTypes.includes(type)) return genesis;
  if (e.capabilities.unrestricted && (profile?.filters?.age_limit || 0) > 0) return genesis;
  return e;
}

module.exports = { get, list, listForType, has, availableFor, resolveFor, DEFAULT_ID, _register };
