// Media lanes (AN-1a). A lane is the INTERNAL type the pool, the builds and the
// engines key on. 'anime' is its own lane so Marquee TV's builds never prune it
// (pruneOtherEngines works per type) — but Stremio/Nuvio only know movie|series,
// so an anime row is served as 'series' items inside a catalog of type 'anime'.
const LANES = Object.freeze(['movie', 'series', 'anime']);
const ITEM_TYPE = Object.freeze({ movie: 'movie', series: 'series', anime: 'series' });

function isLane(t) { return LANES.includes(t); }
// The Stremio item type a lane's titles are served as.
function itemType(lane) { return ITEM_TYPE[lane] || null; }
// The type TMDB, MDBList, the age chain and age_verdicts see for a lane (anime
// titles are TV shows to all of them).
function lookupType(lane) { return lane === 'anime' ? 'series' : lane; }
// dont_recommend types that suppress a lane's row. A title rejected from a
// Stremio catalog arrives as its ITEM type ('series'), so the anime lane honours both.
function dnrTypes(lane) { return lane === 'anime' ? ['anime', 'series'] : [lane]; }

module.exports = { LANES, isLane, itemType, lookupType, dnrTypes };
