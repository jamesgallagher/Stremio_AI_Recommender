// Marquee Anime (AN-1a). Registered so the anime lane, the settings and the UI
// ship and are testable end to end. generate() returns NO candidates until AN-1b:
// a profile with the engine on serves the "List warming up" card. Do NOT add
// sources here in AN-1a.
const settings = require('../settings');

const ALGORITHM_VERSION = 'marquee-anime-a0';

module.exports = {
  id: 'marquee-anime',
  name: 'Marquee Anime',
  description: 'Anime series picked from your watched anime; age-appropriate trending until you have watched five.',
  supportedTypes: ['anime'],
  capabilities: { providesRankScore: true, preResolved: true, serveOrder: 'affinity', unrestricted: false },
  requirements(profile) {
    const missing = [];
    if (!settings.keyFor(profile, 'tmdb_api_key')) missing.push('TMDB key (Server Config)');
    if (!profile?.simkl_auth?.access_token) missing.push('Simkl connection');
    if (!settings.resolveAnidbClient(profile).client) missing.push('AniDB client');
    return { ok: missing.length === 0, missing };
  },
  async generate(profile, type, ctx) {
    ctx.stats = { seeds: 0, raw: 0, strong: 0, kept: 0 };
    return [];
  },
  ALGORITHM_VERSION,
};
