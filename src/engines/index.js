// Engine registry (SC-01). Three engines after AN-1a:
// Marquee Cinema (movies), Marquee TV (series) and Marquee Anime (anime).
// Genesis and Glass were retired — their shared modules live in engines/shared/
// and Marquee runs on them.
const marquee = require('./marquee');
const marqueeTv = require('./marqueeTv');
const marqueeAnime = require('./marqueeAnime');

const REGISTRY = new Map([[marquee.id, marquee], [marqueeTv.id, marqueeTv], [marqueeAnime.id, marqueeAnime]]);
const OFF = 'off';
// The engine each lane uses by default. 'anime' defaults to OFF (Disabled): the
// lane is opt-in per profile (AN-1a mandate 3).
const DEFAULT_IDS = Object.freeze({ movie: 'marquee', series: 'marquee-tv', anime: OFF });
// Lanes whose engine may be switched off. Movies and Shows are mandatory.
const OPTIONAL_LANES = new Set(['anime']);

function get(id) { return REGISTRY.get(id) || null; }
function list() { return [...REGISTRY.values()]; }
function listForType(t) { return list().filter((e) => e.supportedTypes.includes(t)); }
function has(id) { return REGISTRY.has(id); }
function defaultFor(type) { return get(DEFAULT_IDS[type]); }

// Test-only hook (used by conformance/second-engine fixtures) to register a
// stub engine and get a disposer. NOT part of the runtime surface.
function _register(engine) {
  REGISTRY.set(engine.id, engine);
  return () => REGISTRY.delete(engine.id);
}

// availableFor: the engines this profile may CHOOSE for `type` — listForType
// minus any engine that is `unrestricted` ("all ages"/fully open) while the
// profile has an age limit (I7 / overview §5.5). Both Marquee engines are
// always available (no global on/off gate — SC-07 retired with ENG-R).
function availableFor(profile, type) {
  const limited = (profile?.filters?.age_limit || 0) > 0;
  return listForType(type).filter((e) => !(limited && e.capabilities.unrestricted));
}

// isValidFor: may `id` be stored as engine_<type>? OFF only for optional lanes.
function isValidFor(type, id) {
  if (id === OFF) return OPTIONAL_LANES.has(type);
  const e = get(id);
  return !!(e && e.supportedTypes.includes(type));
}

// resolveFor: the effective engine for (profile, type), or NULL when an optional
// lane is off. Movies/Series never return null (they fall back to the default).
// Every caller that can pass 'anime' must handle null (AN-1a §2.2).
function resolveFor(profile, type) {
  const id = profile?.filters?.[`engine_${type}`];
  if (OPTIONAL_LANES.has(type) && (id === undefined || id === null || id === OFF)) return null;
  const e = get(id);
  if (!e || !e.supportedTypes.includes(type)) return defaultFor(type);   // anime: get('off') → null
  if (e.capabilities.unrestricted && (profile?.filters?.age_limit || 0) > 0) return defaultFor(type);
  return e;
}

module.exports = { get, list, listForType, has, defaultFor, availableFor, resolveFor, isValidFor, OFF, DEFAULT_IDS, _register };
