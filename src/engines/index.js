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

// isEnabled (SC-07): the global admin on/off gate, read from Server Config
// (`settings.engines`). Genesis is the permanent default + safe floor and is
// ALWAYS enabled (its stored value, if any, is ignored); every other engine is
// OFF until an admin turns it on — so a code-registered engine ships dark and
// only appears once it is BOTH registered AND enabled. The settings read is lazy
// (settings.js has no dependency on this module, so no require cycle) and
// tolerant of settings being absent/uninitialised → non-Genesis engines read off.
function isEnabled(id) {
  if (id === DEFAULT_ID) return true;                 // Genesis: permanently on
  if (!has(id)) return false;
  const cfg = require('../settings').getSettings()?.engines || {};
  return cfg[id] === true;                            // non-Genesis default OFF
}
function listEnabled() { return list().filter((e) => isEnabled(e.id)); }
function listEnabledFor(type) { return listForType(type).filter((e) => isEnabled(e.id)); }

// availableFor: the engines this profile may CHOOSE for `type` — listForType
// minus any engine that is globally DISABLED (SC-07) or is `unrestricted` ("all
// ages"/fully open) while the profile has an age limit (I7 / overview §5.5).
// Powers the dropdowns (portal + companion) so a disabled or open engine is never
// offered. Genesis (always enabled, unrestricted:false) always survives, so a
// dropdown is never empty.
function availableFor(profile, type) {
  const limited = (profile?.filters?.age_limit || 0) > 0;
  return listForType(type).filter((e) => isEnabled(e.id) && !(limited && e.capabilities.unrestricted));
}

// resolveFor: the effective engine for (profile, type). Falls back to Genesis
// (the guaranteed safe floor) when the stored id is unknown, doesn't support the
// type, is globally DISABLED (SC-07), OR is an unrestricted engine on an
// age-limited profile — so even a hand-edited profiles.json can never build/serve
// from a switched-off engine or serve open content to a kids profile (I7).
function resolveFor(profile, type) {
  const id = profile?.filters?.[`engine_${type}`];
  const e = get(id);
  if (!e || !e.supportedTypes.includes(type)) return genesis;
  if (!isEnabled(e.id)) return genesis;               // SC-07: disabled → safe floor
  if (e.capabilities.unrestricted && (profile?.filters?.age_limit || 0) > 0) return genesis;
  return e;
}

module.exports = { get, list, listForType, has, isEnabled, listEnabled, listEnabledFor, availableFor, resolveFor, DEFAULT_ID, _register };
