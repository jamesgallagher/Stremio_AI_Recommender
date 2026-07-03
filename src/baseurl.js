// Single source of truth for the public base URL used in install links and
// the manifest logo. Tolerates the ways people actually type hostnames:
//   "https://test.url/"      -> "https://test.url"
//   "https://test.url///"    -> "https://test.url"
//   "http://test.url"        -> "http://test.url"   (scheme preserved)
//   " recs.example.com/ "    -> "https://recs.example.com" (scheme added)
function normalizeExternal(raw) {
  let url = (raw || '').trim().replace(/\/+$/, '');
  if (!url) return '';
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
  return url;
}

// EXTERNAL_URL wins; fall back to the host the request arrived on (LAN/dev).
function baseUrl(req) {
  return normalizeExternal(process.env.EXTERNAL_URL) || `${req.protocol}://${req.get('host')}`;
}

module.exports = { baseUrl, normalizeExternal };
