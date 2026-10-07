// Engine registry (SC-01). Two engines remain after ENG-R (7.44):
// Marquee Cinema (movies) and Marquee TV (series). Genesis and Glass were
// retired — their shared modules live in engines/shared/ and Marquee runs on them.
const marquee = require('./marquee');
const marqueeTv = require('./marqueeTv');

const REGISTRY = new Map([[marquee.id, marquee], [marqueeTv.id, marqueeTv]]);
const DEFAULT_IDS = { movie: 'marquee', series: 'marquee-tv' };

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

// resolveFor: the effective engine for (profile, type). Falls back to the
// type's default (DEFAULT_IDS) when the stored id is unknown, doesn't support
// the type, OR is an unrestricted engine on an age-limited profile — so even
// a hand-edited profiles.json can never build/serve from a switched-off engine
// or serve open content to a kids profile (I7).
function resolveFor(profile, type) {
  const id = profile?.filters?.[`engine_${type}`];
  const e = get(id);
  if (!e || !e.supportedTypes.includes(type)) return defaultFor(type);
  if (e.capabilities.unrestricted && (profile?.filters?.age_limit || 0) > 0) return defaultFor(type);
  return e;
}

module.exports = { get, list, listForType, has, defaultFor, availableFor, resolveFor, DEFAULT_IDS, _register };
