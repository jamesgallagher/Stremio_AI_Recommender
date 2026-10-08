// Marquee Anime (AN-1b card 1): age-appropriate trending anime from Simkl + AniList.
const settings = require('../settings');

const ALGORITHM_VERSION = 'marquee-anime-a1';

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
    return require('./marqueeAnime/trending').build(profile, ctx);
  },
  ALGORITHM_VERSION,
};
