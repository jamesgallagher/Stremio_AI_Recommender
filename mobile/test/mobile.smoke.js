// Mobile Companion smoke test — Step 1 (OTP login + sessions).
//
// Same doctrine as test/smoke.js: NO real network (the mail transport is
// injected), deterministic time (nowMs injected), a temp DATA_DIR, and secrets
// sealed with a throwaway key. Run with:
//   node --experimental-sqlite mobile/test/mobile.smoke.js
process.env.DATA_DIR = require('os').tmpdir() + '/ai-rec-mobile-test-' + Date.now();
process.env.PORT = '7312'; // distinct from test/smoke.js (7311)
process.env.SECRET_KEY = process.env.SECRET_KEY || 'test-secret-key-do-not-use-in-prod';
// Enable admin Basic Auth so the HTTP phase can prove /mobile sits OUTSIDE it.
process.env.ADMIN_USER = 'admin';
process.env.ADMIN_PASSWORD = 'test-admin-pw';
// Mail intentionally NOT configured — sendOtpEmail would log; tests inject fakes.
delete process.env.BREVO_API_KEY;
delete process.env.BREVO_SMTP_KEY;
delete process.env.BREVO_SMTP_LOGIN;
delete process.env.MOBILE_MAIL_FROM;
process.env.MOBILE_INSECURE_COOKIE = '1'; // no HTTPS in tests

const assert = require('assert');
const config = require('../../src/config');
const otpStore = require('../server/otpStore');
const mail = require('../server/mail');
const auth = require('../server/auth');
const clientUi = require('../public/ui'); // pure front-end helpers (Step 2)
const clientSwipe = require('../public/swipe'); // pure swipe math (Step 4)
const simkl = require('../../src/services/simkl');
const governor = require('../../src/services/governor');
const recommendationStore = require('../../src/recommendationStore');
const dontRecommend = require('../../src/dontRecommend');
const handlers = require('../server/handlers'); // Step 3/4 data handlers

let passed = 0;
async function ok(name, fn) { await fn(); passed++; console.log(`  ✓ ${name}`); }

// A fake mail transport that captures the code instead of sending it.
function capturingSender() {
  const fn = async (args) => { fn.calls.push(args); return { sent: true, fake: true }; };
  fn.calls = [];
  fn.last = () => fn.calls[fn.calls.length - 1];
  return fn;
}

// Minimal Express-like res for unit-testing handlers without HTTP.
function fakeRes() {
  return {
    statusCode: 200, body: null,
    status(c) { this.statusCode = c; return this; },
    json(o) { this.body = o; return this; },
  };
}

let emailSeq = 0;
const uniqEmail = () => `user${++emailSeq}@example.com`;
function seedProfile(name, email) {
  const p = config.addProfile(name);
  if (email !== undefined) config.updateProfile(p.id, { email });
  return config.getProfile(p.id);
}

async function unitTests() {
  console.log('mobile unit:');
  const DAY = 24 * 3600e3;

  await ok('otp: generateCode is 6 numeric digits', () => {
    for (let i = 0; i < 100; i++) assert.match(auth.generateCode(), /^\d{6}$/);
  });

  await ok('otp: code stored hashed, never plaintext', async () => {
    auth._resetRateLimits();
    const email = uniqEmail(); const p = seedProfile('Hashed', email);
    const send = capturingSender();
    const r = await auth.requestOtp(email, { sendMail: send });
    assert.strictEqual(r.issued, true);
    const code = send.last().code;
    const row = otpStore.newestUnusedOtp(auth.normalizeEmail(email));
    assert.strictEqual(row.profile_id, p.id);
    assert.notStrictEqual(row.code_hash, code);          // not the plaintext
    assert.strictEqual(row.code_hash, otpStore.sha256(code)); // is its hash
  });

  await ok('otp: correct code verifies once, then is single-use', async () => {
    auth._resetRateLimits();
    const email = uniqEmail(); seedProfile('Single', email);
    const send = capturingSender();
    await auth.requestOtp(email, { sendMail: send });
    const code = send.last().code;
    assert.strictEqual(auth.verifyOtp(email, code).ok, true);
    assert.strictEqual(auth.verifyOtp(email, code).ok, false); // reused
  });

  await ok('otp: expires at 1 hour (valid at 59 min, dead at 61)', async () => {
    const t0 = Date.parse('2026-01-01T00:00:00Z');
    const email = uniqEmail(); seedProfile('Expiry', email);
    const send = capturingSender();
    auth._resetRateLimits();
    await auth.requestOtp(email, { nowMs: t0, sendMail: send });
    assert.strictEqual(auth.verifyOtp(email, send.last().code, { nowMs: t0 + 59 * 60e3 }).ok, true);
    auth._resetRateLimits(); // fresh code for the expiry branch
    await auth.requestOtp(email, { nowMs: t0, sendMail: send });
    assert.strictEqual(auth.verifyOtp(email, send.last().code, { nowMs: t0 + 61 * 60e3 }).ok, false);
  });

  await ok('otp: wrong code fails, locks out after MAX attempts, fresh request re-enables', async () => {
    auth._resetRateLimits();
    const email = uniqEmail(); seedProfile('Attempts', email);
    const send = capturingSender();
    await auth.requestOtp(email, { sendMail: send });
    const code = send.last().code;
    const wrong = code === '000000' ? '000001' : '000000';
    for (let i = 0; i < auth.MAX_ATTEMPTS; i++) assert.strictEqual(auth.verifyOtp(email, wrong).ok, false);
    assert.strictEqual(auth.verifyOtp(email, code).ok, false, 'correct code rejected once locked');
    auth._resetRateLimits();
    await auth.requestOtp(email, { sendMail: send });
    assert.strictEqual(auth.verifyOtp(email, send.last().code).ok, true, 'a fresh code works again');
  });

  await ok('otp: strict 1:1 — issues for one match, refuses 0 or 2+', async () => {
    const send = capturingSender();
    auth._resetRateLimits();
    const only = uniqEmail(); seedProfile('Only', only);
    assert.strictEqual((await auth.requestOtp(only, { sendMail: send })).issued, true);
    // zero matches -> generic ok, nothing stored
    auth._resetRateLimits();
    const none = uniqEmail();
    const r0 = await auth.requestOtp(none, { sendMail: send });
    assert.deepStrictEqual([r0.ok, r0.issued, r0.reason], [true, false, 'none']);
    assert.strictEqual(otpStore.newestUnusedOtp(auth.normalizeEmail(none)), null);
    // two matches -> config error, generic ok, nothing stored
    auth._resetRateLimits();
    const dup = uniqEmail(); seedProfile('Dup1', dup); seedProfile('Dup2', dup);
    const r2 = await auth.requestOtp(dup, { sendMail: send });
    assert.deepStrictEqual([r2.ok, r2.issued, r2.reason], [true, false, 'ambiguous']);
    assert.strictEqual(otpStore.newestUnusedOtp(auth.normalizeEmail(dup)), null);
  });

  await ok('otp: email match is case/space-insensitive', async () => {
    auth._resetRateLimits();
    const p = seedProfile('Case', 'MixedCase@Example.com');
    const send = capturingSender();
    const r = await auth.requestOtp('  mixedcase@example.COM ', { sendMail: send });
    assert.strictEqual(r.issued, true);
    assert.strictEqual(otpStore.newestUnusedOtp('mixedcase@example.com').profile_id, p.id);
  });

  await ok('otp: only one live code per email (new request purges the old)', async () => {
    auth._resetRateLimits();
    const email = uniqEmail(); seedProfile('OneLive', email);
    const send = capturingSender();
    await auth.requestOtp(email, { sendMail: send });
    const oldCode = send.last().code;
    await auth.requestOtp(email, { sendMail: send });
    const newCode = send.last().code;
    if (oldCode !== newCode) assert.strictEqual(auth.verifyOtp(email, oldCode).ok, false, 'old code purged');
    assert.strictEqual(auth.verifyOtp(email, newCode).ok, true, 'new code works');
  });

  await ok('session: verify creates a session bound to the issuing profile', async () => {
    auth._resetRateLimits();
    const email = uniqEmail(); const p = seedProfile('Sess', email);
    const send = capturingSender();
    await auth.requestOtp(email, { sendMail: send });
    const res = auth.verifyOtp(email, send.last().code);
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.profile.id, p.id);
    assert.strictEqual(auth.resolveSession(res.token).id, p.id);
  });

  await ok('session: token stored hashed, raw token resolves', async () => {
    auth._resetRateLimits();
    const email = uniqEmail(); seedProfile('TokHash', email);
    const send = capturingSender();
    await auth.requestOtp(email, { sendMail: send });
    const { token } = auth.verifyOtp(email, send.last().code);
    const row = otpStore.sessionByToken(token);
    assert.ok(row);
    assert.strictEqual(row.token_hash, otpStore.sha256(token));
    assert.notStrictEqual(row.token_hash, token);
  });

  await ok('session: expired session is rejected + cleaned', async () => {
    auth._resetRateLimits();
    const t0 = Date.parse('2026-02-01T00:00:00Z');
    const email = uniqEmail(); seedProfile('SessExp', email);
    const send = capturingSender();
    await auth.requestOtp(email, { nowMs: t0, sendMail: send });
    const { token } = auth.verifyOtp(email, send.last().code, { nowMs: t0 });
    assert.ok(auth.resolveSession(token, { nowMs: t0 + DAY }));
    const dead = t0 + (auth.SESSION_DAYS + 1) * DAY;
    assert.strictEqual(auth.resolveSession(token, { nowMs: dead }), null);
    assert.strictEqual(otpStore.sessionByToken(token), null, 'expired session cleaned up');
  });

  await ok('session: logout revokes the token', async () => {
    auth._resetRateLimits();
    const email = uniqEmail(); seedProfile('Logout', email);
    const send = capturingSender();
    await auth.requestOtp(email, { sendMail: send });
    const { token } = auth.verifyOtp(email, send.last().code);
    assert.ok(auth.resolveSession(token));
    auth.logout(token);
    assert.strictEqual(auth.resolveSession(token), null);
  });

  await ok('isolation: each session resolves ONLY to its own profile', async () => {
    const send = capturingSender();
    auth._resetRateLimits();
    const ea = uniqEmail(); const pa = seedProfile('Alice', ea);
    await auth.requestOtp(ea, { sendMail: send });
    const ta = auth.verifyOtp(ea, send.last().code).token;
    auth._resetRateLimits();
    const eb = uniqEmail(); const pb = seedProfile('Bob', eb);
    await auth.requestOtp(eb, { sendMail: send });
    const tb = auth.verifyOtp(eb, send.last().code).token;
    assert.notStrictEqual(pa.id, pb.id);
    assert.strictEqual(auth.resolveSession(ta).id, pa.id);
    assert.strictEqual(auth.resolveSession(tb).id, pb.id); // never crosses over
  });

  await ok('mail: buildOtpMessage carries code, TTL, sender, recipient (nodemailer shape)', () => {
    const msg = mail.buildOtpMessage({ to: 'x@y.com', from: 'no-reply@z.com', fromName: 'Recs', code: '123456', ttlMinutes: 60 });
    assert.deepStrictEqual(msg.from, { name: 'Recs', address: 'no-reply@z.com' });
    assert.strictEqual(msg.to, 'x@y.com');
    assert.ok(msg.subject.includes('123456'));
    assert.ok(msg.text.includes('123456') && msg.text.includes('60'));
    assert.ok(msg.html.includes('123456'));
  });

  await ok('mail: unconfigured -> dev log, send NOT called', async () => {
    let called = false;
    const send = async () => { called = true; };
    const r = await mail.sendOtpEmail({ to: 'x@y.com', code: '000111' }, send);
    assert.deepStrictEqual([r.sent, r.dev, called], [false, true, false]);
  });

  await ok('mail: configured -> builds message + calls send (offline fake transport)', async () => {
    process.env.BREVO_SMTP_LOGIN = 'login@smtp-brevo.com';
    process.env.BREVO_SMTP_KEY = 'xsmtpsib-test';
    process.env.MOBILE_MAIL_FROM = 'no-reply@z.com';
    try {
      let captured = null;
      const send = async (msg) => { captured = msg; return { messageId: '<abc@test>' }; };
      const r = await mail.sendOtpEmail({ to: 'u@x.com', code: '424242', ttlMinutes: 60 }, send);
      assert.deepStrictEqual([r.sent, r.id], [true, '<abc@test>']);
      assert.strictEqual(captured.to, 'u@x.com');
      assert.strictEqual(captured.from.address, 'no-reply@z.com');
      assert.ok(captured.subject.includes('424242'));
    } finally {
      delete process.env.BREVO_SMTP_LOGIN; delete process.env.BREVO_SMTP_KEY; delete process.env.MOBILE_MAIL_FROM;
    }
  });

  await ok('rate limit: suppresses after MAX_REQUESTS in-window, resets after', async () => {
    auth._resetRateLimits();
    const email = uniqEmail(); seedProfile('Rated', email);
    const send = capturingSender();
    const t0 = Date.parse('2026-03-01T00:00:00Z');
    let issued = 0;
    for (let i = 0; i < auth.MAX_REQUESTS; i++) {
      if ((await auth.requestOtp(email, { nowMs: t0, sendMail: send })).issued) issued++;
    }
    assert.strictEqual(issued, auth.MAX_REQUESTS);
    const over = await auth.requestOtp(email, { nowMs: t0, sendMail: send });
    assert.deepStrictEqual([over.issued, over.reason], [false, 'rate-limited']);
    const after = await auth.requestOtp(email, { nowMs: t0 + (auth.RATE_WINDOW_MS + 60e3), sendMail: send });
    assert.strictEqual(after.issued, true);
  });

  await ok('otp: send is fire-and-forget (requestOtp does not block on SMTP latency)', async () => {
    auth._resetRateLimits();
    const email = uniqEmail(); seedProfile('FireForget', email);
    // A send that never settles on its own — if requestOtp awaited it, this hangs.
    let release;
    const slow = (args) => new Promise((res) => { slow.args = args; release = res; });
    const r = await auth.requestOtp(email, { sendMail: slow });
    assert.strictEqual(r.issued, true);                     // returned without awaiting the send
    assert.ok(slow.args && /^\d{6}$/.test(slow.args.code)); // the send was kicked off with the code
    release({ sent: true });                                // settle the dangling promise
  });

  // ---- Step 2: pure UI helpers (ui.js) ----
  await ok('ui: parseRoute maps hash -> view, unknown/empty -> default', () => {
    assert.strictEqual(clientUi.parseRoute('#/search').view, 'search');
    assert.strictEqual(clientUi.parseRoute('#/recs').view, 'recs');
    assert.strictEqual(clientUi.parseRoute('#/login').view, 'login');
    assert.strictEqual(clientUi.parseRoute('').view, clientUi.DEFAULT_VIEW);
    assert.strictEqual(clientUi.parseRoute('#/').view, clientUi.DEFAULT_VIEW);
    assert.strictEqual(clientUi.parseRoute('#/bogus').view, clientUi.DEFAULT_VIEW);
    assert.strictEqual(clientUi.parseRoute('#/search?q=x').view, 'search'); // query stripped
  });

  await ok('ui: viewForState gates on auth', () => {
    assert.strictEqual(clientUi.viewForState({ authed: false, route: 'search' }), 'login');
    assert.strictEqual(clientUi.viewForState({ authed: false }), 'login');
    assert.strictEqual(clientUi.viewForState({ authed: true, route: 'search' }), 'search');
    assert.strictEqual(clientUi.viewForState({ authed: true, route: 'login' }), clientUi.DEFAULT_VIEW); // no login when authed
    assert.strictEqual(clientUi.viewForState({ authed: true, route: 'bogus' }), clientUi.DEFAULT_VIEW);
    assert.strictEqual(clientUi.viewForState({ authed: true }), clientUi.DEFAULT_VIEW);
  });

  // ---- Step 3: Simkl plan-to-watch write ----
  await ok('simkl: buildAddToListBody routes by kind, sets plantowatch, id preference, skips id-less', () => {
    const body = simkl.buildAddToListBody([
      { type: 'movie', tmdb_id: 603, imdb_id: 'tt0133093' },
      { type: 'series', tmdb_id: '1399' },
      { type: 'movie', title: 'no ids here' },   // dropped
      null,                                       // dropped
    ]);
    assert.strictEqual(body.movies.length, 1);
    assert.strictEqual(body.shows.length, 1);
    assert.deepStrictEqual(body.movies[0], { to: 'plantowatch', ids: { imdb: 'tt0133093', tmdb: '603' } });
    assert.deepStrictEqual(body.shows[0], { to: 'plantowatch', ids: { tmdb: '1399' } });
    // single item (not an array) is accepted; tmdb stringified
    assert.deepStrictEqual(simkl.buildAddToListBody({ type: 'movie', tmdb_id: 27205 }).movies[0].ids, { tmdb: '27205' });
    // does not mutate the input
    const input = Object.freeze({ type: 'movie', tmdb_id: '1' });
    assert.doesNotThrow(() => simkl.buildAddToListBody([input]));
  });

  await ok('simkl: addToPlanToWatch throws when not connected (no fetch)', async () => {
    await assert.rejects(
      () => simkl.addToPlanToWatch({ keys: {}, simkl_auth: null }, { type: 'movie', tmdb_id: '1' }),
      /not connected/i,
    );
  });

  await ok('simkl: addToPlanToWatch short-circuits an all-id-less payload (no fetch)', async () => {
    const r = await simkl.addToPlanToWatch(
      { keys: { simkl_client_id: 'c' }, simkl_auth: { access_token: 't' } },
      [{ type: 'movie', title: 'no ids' }],
    );
    assert.strictEqual(r.skipped, true);
  });

  await ok('simkl: addToPlanToWatch paces on simkl_post + returns Simkl response', async () => {
    const origSchedule = governor.schedule; const origFetch = global.fetch;
    let scheduledService = null; let sentBody = null;
    governor.schedule = (service, fn) => { scheduledService = service; return fn(); };
    global.fetch = async (url, opts) => { sentBody = JSON.parse(opts.body); return { ok: true, status: 200, json: async () => ({ added: { movies: 1 } }) }; };
    try {
      const r = await simkl.addToPlanToWatch(
        { keys: { simkl_client_id: 'c' }, simkl_auth: { access_token: 't' } },
        { type: 'movie', tmdb_id: '603' },
      );
      assert.strictEqual(scheduledService, 'simkl_post');       // hard 1-POST/s write cap
      assert.deepStrictEqual(sentBody.movies[0], { to: 'plantowatch', ids: { tmdb: '603' } });
      assert.deepStrictEqual(r.added, { movies: 1 });
    } finally { governor.schedule = origSchedule; global.fetch = origFetch; }
  });

  // ---- Step 3: handlers ----
  await ok('handlers: toTitleDTO maps meta -> DTO, drops nulls, no mutation', () => {
    const meta = Object.freeze({
      id: 'tt1375666', type: 'movie', name: 'Inception', releaseInfo: '2010',
      poster: 'http://img/p.jpg', description: 'A thief…', imdbRating: '8.4', _tmdb_id: 27205,
    });
    assert.deepStrictEqual(handlers.toTitleDTO(meta), {
      id: 'tt1375666', type: 'movie', title: 'Inception', year: 2010,
      poster: 'http://img/p.jpg', synopsis: 'A thief…', rating: '8.4', tmdb_id: '27205',
    });
    // nulls handled: no poster/rating/year -> null/empty, not undefined
    const bare = handlers.toTitleDTO({ id: 'tt2', type: 'series', name: 'X' });
    assert.deepStrictEqual([bare.poster, bare.rating, bare.year, bare.synopsis, bare.tmdb_id], [null, null, null, '', null]);
    assert.strictEqual(handlers.toTitleDTO(null), null);
  });

  await ok('handlers: searchHandler rejects a short query (400, no network)', async () => {
    const res = fakeRes();
    await handlers.searchHandler({ query: { q: 'a' }, profile: { keys: {} } }, res);
    assert.strictEqual(res.statusCode, 400);
  });

  await ok('handlers: watchlistHandler validation (type + ids + Simkl connection)', async () => {
    const connected = { id: 'A', keys: {}, simkl_auth: { access_token: 't' } };
    let res = fakeRes();
    await handlers.watchlistHandler({ profile: connected, body: { tmdb_id: '1' } }, res); // no type
    assert.strictEqual(res.statusCode, 400);
    res = fakeRes();
    await handlers.watchlistHandler({ profile: connected, body: { type: 'movie' } }, res); // no ids
    assert.strictEqual(res.statusCode, 400);
    res = fakeRes();
    await handlers.watchlistHandler({ profile: { id: 'B', keys: {}, simkl_auth: null }, body: { type: 'movie', tmdb_id: '1' } }, res);
    assert.strictEqual(res.statusCode, 400); // Simkl not connected
    assert.match(res.body.error, /not connected/i);
  });

  await ok('handlers: watchlistHandler uses req.profile, never a body profile id (isolation)', async () => {
    const orig = simkl.addToPlanToWatch;
    let gotProfileId = null;
    simkl.addToPlanToWatch = async (profile) => { gotProfileId = profile.id; return { added: { movies: 1 } }; };
    try {
      const res = fakeRes();
      const req = { profile: { id: 'A', keys: {}, simkl_auth: { access_token: 't' } }, body: { type: 'movie', tmdb_id: '603', profile_id: 'B' } };
      await handlers.watchlistHandler(req, res);
      assert.strictEqual(gotProfileId, 'A');     // the session profile, NOT body.profile_id 'B'
      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(res.body.ok, true);
    } finally { simkl.addToPlanToWatch = orig; }
  });

  // ---- Step 4: recommendations tabs + swipe ----
  const mkCand = (o) => ({ type: 'movie', tmdb_id: '1', imdb_id: 'tt1', title: 'T', year: 2000, primary_genre: 'Action', genres: 'Action', vote_average: 7, affinity: 1, rec_count: 1, popularity: 1, poster: null, ...o });

  await ok('handlers: toRecDTO maps a pool row -> DTO (nulls + unrated handled)', () => {
    const row = Object.freeze({ imdb_id: 'tt0325980', tmdb_id: '22', type: 'movie', title: 'POTC', year: 2003, poster: 'http://p', primary_genre: 'Adventure', vote_average: 7.9, because_title: 'Cutthroat Island' });
    assert.deepStrictEqual(handlers.toRecDTO(row), {
      id: 'tt0325980', tmdb_id: '22', type: 'movie', title: 'POTC', year: 2003,
      poster: 'http://p', genre: 'Adventure', rating: 7.9, because: 'Cutthroat Island',
    });
    const bare = handlers.toRecDTO({ imdb_id: 'tt1', tmdb_id: '1', type: 'series', title: 'X', year: 0, vote_average: 0 });
    assert.deepStrictEqual([bare.poster, bare.genre, bare.because, bare.rating, bare.year], [null, null, null, null, null]);
    assert.strictEqual(handlers.toRecDTO(null), null);
  });

  await ok('swipe: right past threshold -> remove/red "Remove"; left -> save/green "Add to watch later"', () => {
    const W = 300;
    const right = clientSwipe.swipeOutcome(0.3 * W, W);
    assert.deepStrictEqual([right.action, right.color, right.label, right.direction], ['remove', clientSwipe.REMOVE_COLOR, 'Remove', 'right']);
    const left = clientSwipe.swipeOutcome(-0.3 * W, W);
    assert.deepStrictEqual([left.action, left.color, left.label, left.direction], ['save', clientSwipe.SAVE_COLOR, 'Add to watch later', 'left']);
  });

  await ok('swipe: under threshold -> action none but colour/label show on any dx; progress clamps', () => {
    const W = 300;
    const small = clientSwipe.swipeOutcome(10, W);
    assert.strictEqual(small.action, 'none');                 // not committed yet
    assert.strictEqual(small.color, clientSwipe.REMOVE_COLOR); // affordance appears immediately
    assert.ok(small.progress > 0 && small.progress < 1);
    const neutral = clientSwipe.swipeOutcome(0, W);
    assert.deepStrictEqual([neutral.action, neutral.color, neutral.progress], ['none', null, 0]);
    assert.strictEqual(clientSwipe.swipeOutcome(9999, W).progress, 1); // clamped to 1
  });

  await ok('handlers: recommendationsHandler returns items per type for the session profile', () => {
    const pid = 'rec-h-' + Date.now();
    recommendationStore.upsertCandidates(pid, [
      mkCand({ type: 'movie', tmdb_id: '603', imdb_id: 'tt0133093', title: 'The Matrix', year: 1999, poster: 'http://p' }),
      mkCand({ type: 'series', tmdb_id: '1399', imdb_id: 'tt0944947', title: 'GoT', year: 2011, primary_genre: 'Drama', genres: 'Drama' }),
    ]);
    let res = fakeRes();
    handlers.recommendationsHandler({ query: { type: 'movie' }, profile: { id: pid } }, res);
    assert.strictEqual(res.body.type, 'movie');
    assert.deepStrictEqual(res.body.items.map((r) => r.id), ['tt0133093']);
    res = fakeRes();
    handlers.recommendationsHandler({ query: { type: 'series' }, profile: { id: pid } }, res);
    assert.deepStrictEqual(res.body.items.map((r) => r.title), ['GoT']);
    res = fakeRes(); // unknown type -> defaults to movie
    handlers.recommendationsHandler({ query: { type: 'bogus' }, profile: { id: pid } }, res);
    assert.strictEqual(res.body.type, 'movie');
    recommendationStore.deleteForProfile(pid);
  });

  await ok('handlers: recommendationsHandler empty pool -> empty items (no padding)', () => {
    const res = fakeRes();
    handlers.recommendationsHandler({ query: { type: 'movie' }, profile: { id: 'nobody-' + Date.now() } }, res);
    assert.deepStrictEqual(res.body.items, []);
  });

  await ok('handlers: suppressHandler removes from the pool (shared dontRecommend path)', async () => {
    const pid = 'sup-h-' + Date.now();
    recommendationStore.upsertCandidates(pid, [mkCand({ tmdb_id: '603', imdb_id: 'tt0133093', title: 'The Matrix' })]);
    const res = fakeRes();
    await handlers.suppressHandler({ profile: { id: pid, keys: {}, name: 'T' }, body: { type: 'movie', tmdb_id: '603' } }, res);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(recommendationStore.countRecommended(pid), 0);
    assert.ok(recommendationStore.dontRecommendKeys(pid).has('movie:603'));
    recommendationStore.deleteForProfile(pid);
  });

  await ok('handlers: unsuppressHandler clears a USER rejection but never a decayed one', () => {
    const pid = 'uns-h-' + Date.now();
    recommendationStore.addDontRecommend(pid, 'movie', '603', 'user');
    recommendationStore.addDontRecommend(pid, 'series', '1399', 'decayed');
    let res = fakeRes();
    handlers.unsuppressHandler({ profile: { id: pid }, body: { type: 'movie', tmdb_id: '603' } }, res);
    assert.strictEqual(res.body.restored, 1);
    assert.ok(!recommendationStore.dontRecommendKeys(pid).has('movie:603')); // user flag cleared
    res = fakeRes();
    handlers.unsuppressHandler({ profile: { id: pid }, body: { type: 'series', tmdb_id: '1399' } }, res);
    assert.strictEqual(res.body.restored, 0);                                 // decayed untouched
    assert.ok(recommendationStore.dontRecommendKeys(pid).has('series:1399'));
    recommendationStore.deleteForProfile(pid);
  });

  await ok('regression: mobile remove == shared dontRecommend.suppress (surface parity)', async () => {
    const pid = 'parity-' + Date.now();
    recommendationStore.upsertCandidates(pid, [
      mkCand({ tmdb_id: '11', imdb_id: 'tt11', title: 'A' }),
      mkCand({ tmdb_id: '22', imdb_id: 'tt22', title: 'B' }),
    ]);
    const profile = { id: pid, keys: {}, name: 'P' };
    await dontRecommend.suppress(profile, { type: 'movie', tmdbId: '11' });        // portal / in-player path
    await handlers.suppressHandler({ profile, body: { type: 'movie', tmdb_id: '22' } }, fakeRes()); // mobile path
    const keys = recommendationStore.dontRecommendKeys(pid);
    assert.ok(keys.has('movie:11') && keys.has('movie:22'), 'both surfaces produce the same suppression');
    assert.strictEqual(recommendationStore.countRecommended(pid), 0);
    recommendationStore.deleteForProfile(pid);
  });

  await ok('regression: recommendations are per-profile (isolation)', () => {
    const A = 'iso-A-' + Date.now(); const B = 'iso-B-' + Date.now();
    recommendationStore.upsertCandidates(A, [mkCand({ imdb_id: 'ttA', tmdb_id: '603', title: 'A-movie' })]);
    const res = fakeRes();
    handlers.recommendationsHandler({ query: { type: 'movie' }, profile: { id: B, filters: {}, companion: { catalog_only: false } } }, res);
    assert.deepStrictEqual(res.body.items, []); // B sees nothing of A's pool
    recommendationStore.deleteForProfile(A);
  });

  // ---- Step 5: catalog vs entire-list views + settings ----

  await ok('recs: passesAgeBand keeps unrated/in-band, drops over-band for kids, adult keeps all', () => {
    const adult = {}; const kid = { age_limit: 8 };
    assert.strictEqual(recommendationStore.passesAgeBand({ age_classification: 'R' }, adult), true);  // no limit
    assert.strictEqual(recommendationStore.passesAgeBand({ age_classification: 'R' }, kid), false);   // 17 > 9
    assert.strictEqual(recommendationStore.passesAgeBand({ age_classification: 'PG' }, kid), true);   // 8 <= 9
    assert.strictEqual(recommendationStore.passesAgeBand({ age_classification: null }, kid), true);   // unrated -> kept
  });

  await ok('recs: catalog view = served selection, display_count = list_size, first rows == Stremio prefix', () => {
    const pid = 'rec5-cat-' + Date.now();
    const rows = [];
    for (let i = 0; i < 8; i++) rows.push(mkCand({ tmdb_id: String(100 + i), imdb_id: 'tt10' + i, title: 'M' + i, affinity: 8 - i }));
    recommendationStore.upsertCandidates(pid, rows); // one genre -> balance is pure affinity order
    const profile = { id: pid, filters: { list_size: 5 }, companion: { catalog_only: true } }; // 5 = the list_size floor
    const res = fakeRes();
    handlers.recommendationsHandler({ query: { type: 'movie' }, profile }, res);
    assert.strictEqual(res.body.view, 'catalog');
    assert.strictEqual(res.body.display_count, 5);
    const serve = recommendationStore.serveRecommendations(profile, 'movie', { limit: 5 }).map((m) => m.id);
    assert.deepStrictEqual(res.body.items.slice(0, 5).map((r) => r.id), serve); // phone mirrors Stremio exactly
    assert.ok(res.body.items.length > 5, 'carries a hidden on-deck bench beyond display_count');
    recommendationStore.deleteForProfile(pid);
  });

  await ok('recs: entire-list view returns the whole pool (adult) and is age-band filtered (kids)', () => {
    const pid = 'rec5-all-' + Date.now();
    recommendationStore.upsertCandidates(pid, [
      mkCand({ tmdb_id: '201', imdb_id: 'tt201', title: 'Kiddo', affinity: 3 }),
      mkCand({ tmdb_id: '202', imdb_id: 'tt202', title: 'Grown', affinity: 2 }),
    ]);
    recommendationStore.setAgeClassification(pid, 'movie', '202', 'R'); // 17+
    let res = fakeRes();
    handlers.recommendationsHandler({ query: { type: 'movie', view: 'all' }, profile: { id: pid, filters: {} } }, res);
    assert.strictEqual(res.body.view, 'all');
    assert.deepStrictEqual(res.body.items.map((r) => r.id).sort(), ['tt201', 'tt202']); // adult: whole pool
    assert.strictEqual(res.body.display_count, res.body.items.length);
    res = fakeRes();
    handlers.recommendationsHandler({ query: { type: 'movie', view: 'all' }, profile: { id: pid, filters: { age_limit: 8 } } }, res);
    assert.deepStrictEqual(res.body.items.map((r) => r.id), ['tt201']); // kids: R-rated dropped (vetted-only)
    recommendationStore.deleteForProfile(pid);
  });

  await ok('recs: default view follows companion.catalog_only; explicit ?view overrides it', () => {
    const pid = 'rec5-pref-' + Date.now();
    recommendationStore.upsertCandidates(pid, [mkCand({ tmdb_id: '301', imdb_id: 'tt301', title: 'P' })]);
    const base = { id: pid, filters: {} };
    let res = fakeRes();
    handlers.recommendationsHandler({ query: { type: 'movie' }, profile: { ...base, companion: { catalog_only: false } } }, res);
    assert.strictEqual(res.body.view, 'all');
    res = fakeRes();
    handlers.recommendationsHandler({ query: { type: 'movie' }, profile: { ...base, companion: { catalog_only: true } } }, res);
    assert.strictEqual(res.body.view, 'catalog');
    res = fakeRes();
    handlers.recommendationsHandler({ query: { type: 'movie', view: 'all' }, profile: { ...base, companion: { catalog_only: true } } }, res);
    assert.strictEqual(res.body.view, 'all'); // explicit override wins
    recommendationStore.deleteForProfile(pid);
  });

  await ok('recs: removing a catalog title promotes the next bench title (one in, one out)', () => {
    const pid = 'rec5-oneout-' + Date.now();
    const rows = [];
    for (let i = 0; i < 8; i++) rows.push(mkCand({ tmdb_id: String(400 + i), imdb_id: 'tt40' + i, title: 'T' + i, affinity: 8 - i }));
    recommendationStore.upsertCandidates(pid, rows);
    const profile = { id: pid, filters: { list_size: 5 }, companion: { catalog_only: true } };
    let res = fakeRes();
    handlers.recommendationsHandler({ query: { type: 'movie' }, profile }, res);
    assert.deepStrictEqual(res.body.items.slice(0, 5).map((r) => r.id), ['tt400', 'tt401', 'tt402', 'tt403', 'tt404']); // visible 5
    recommendationStore.addDontRecommend(pid, 'movie', '402', 'user');                        // remove one in the middle
    res = fakeRes();
    handlers.recommendationsHandler({ query: { type: 'movie' }, profile }, res);
    assert.deepStrictEqual(res.body.items.slice(0, 5).map((r) => r.id), ['tt400', 'tt401', 'tt403', 'tt404', 'tt405']); // tt405 promoted from the bench
    recommendationStore.deleteForProfile(pid);
  });

  await ok('settings: toCompanionFilters exposes the 5 editable filters, never the age gate', () => {
    const out = handlers.toCompanionFilters({ min_rating: 6, vote_count_floor: 1000, max_age_years: 5, excluded_genres: ['Horror'], list_size: 20, age_limit: 8, engine: 'trakt' });
    assert.deepStrictEqual(Object.keys(out).sort(), ['excluded_genres', 'list_size', 'max_age_years', 'min_rating', 'vote_count_floor']);
    assert.ok(!('age_limit' in out), 'age gate never exposed');
    assert.deepStrictEqual(out.excluded_genres, ['Horror']);
    assert.deepStrictEqual(handlers.toCompanionFilters({}).excluded_genres, []); // always an array
  });

  await ok('settings: GET returns editable filters + genres + catalog_only, hides the age gate', () => {
    const p = config.addProfile('SetGet');
    config.updateProfile(p.id, { filters: { min_rating: 7, age_limit: 8 } });
    const res = fakeRes();
    handlers.settingsGetHandler({ profile: config.getProfile(p.id) }, res);
    assert.strictEqual(res.body.filters.min_rating, 7);
    assert.ok(!('age_limit' in res.body.filters), 'age gate absent');
    assert.strictEqual(res.body.catalog_only, true); // default
    assert.ok(Array.isArray(res.body.genres) && res.body.genres.length > 0);
  });

  await ok('settings: POST whitelists — writes filters + pref, the age gate is immutable', () => {
    const p = config.addProfile('SetPost');
    config.updateProfile(p.id, { filters: { age_limit: 8 } }); // an age-limited (kids) profile
    const res = fakeRes();
    handlers.settingsPostHandler({
      profile: config.getProfile(p.id),
      body: { min_rating: 7.5, list_size: 30, catalog_only: false, age_limit: 0 }, // age_limit MUST be ignored
    }, res);
    assert.strictEqual(res.body.ok, true);
    const after = config.getProfile(p.id);
    assert.strictEqual(after.filters.min_rating, 7.5);        // written
    assert.strictEqual(after.filters.list_size, 30);          // written
    assert.strictEqual(after.companion.catalog_only, false);  // written
    assert.strictEqual(after.filters.age_limit, 8, 'age gate untouched by the Companion');
    assert.ok(!('age_limit' in res.body.filters), 'response never echoes the age gate');
  });

  await ok('settings: POST with only forbidden/unknown keys -> 400 (age gate alone cannot write)', () => {
    const p = config.addProfile('SetEmpty');
    const res = fakeRes();
    handlers.settingsPostHandler({ profile: config.getProfile(p.id), body: { age_limit: 0, foo: 'bar' } }, res);
    assert.strictEqual(res.statusCode, 400);
  });
}

// ---- HTTP surface (boots the real server, hits it with global fetch) ----
async function httpTests() {
  console.log('mobile http:');
  require('../../src/server'); // calls app.listen on process.env.PORT
  const BASE = `http://localhost:${process.env.PORT}`;
  await new Promise((r) => setTimeout(r, 500)); // let it bind
  const adminHeader = 'Basic ' + Buffer.from(`${process.env.ADMIN_USER}:${process.env.ADMIN_PASSWORD}`).toString('base64');

  // Admin /api still enforces Basic Auth — mounting /mobile didn't loosen it.
  {
    assert.strictEqual((await fetch(`${BASE}/api/version`)).status, 401);
    assert.strictEqual((await fetch(`${BASE}/api/version`, { headers: { Authorization: adminHeader } })).status, 200);
    console.log('  ✓ regression: admin /api still behind Basic Auth');
  }

  // Mobile auth routes are public (no Basic Auth) and answer the generic 200.
  {
    const res = await fetch(`${BASE}/mobile/api/auth/request`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'nobody@example.com' }),
    });
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(await res.json(), { ok: true });
    console.log('  ✓ regression: /mobile/api/auth/request is public + generic');
  }

  // Data routes require a session (401 from the guard, not from Basic Auth).
  {
    const res = await fetch(`${BASE}/mobile/api/me`);
    assert.strictEqual(res.status, 401);
    assert.strictEqual((await res.json()).error, 'Not signed in');
    console.log('  ✓ regression: /mobile data routes require a session');
  }

  // End-to-end: issue in-process (to read the code), verify over HTTP, use the
  // cookie on /me, then logout revokes it.
  {
    const email = uniqEmail(); const p = seedProfile('HttpUser', email);
    const send = capturingSender();
    auth._resetRateLimits();
    await auth.requestOtp(email, { sendMail: send });
    const code = send.last().code;

    const vres = await fetch(`${BASE}/mobile/api/auth/verify`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, code }),
    });
    assert.strictEqual(vres.status, 200);
    const setCookie = vres.headers.get('set-cookie') || '';
    assert.ok(setCookie.includes('mobile_sid='), 'session cookie is set');
    assert.ok(/HttpOnly/i.test(setCookie), 'cookie is HttpOnly');
    const cookie = setCookie.split(';')[0]; // mobile_sid=<token>
    assert.strictEqual((await vres.json()).profile.id, p.id);

    const me = await fetch(`${BASE}/mobile/api/me`, { headers: { Cookie: cookie } });
    assert.strictEqual(me.status, 200);
    const meBody = await me.json();
    assert.strictEqual(meBody.profile.id, p.id);
    assert.strictEqual(meBody.profile.simkl_connected, false);

    assert.strictEqual((await fetch(`${BASE}/mobile/api/me`, { headers: { Cookie: 'mobile_sid=deadbeef' } })).status, 401);

    const lo = await fetch(`${BASE}/mobile/api/auth/logout`, { method: 'POST', headers: { Cookie: cookie } });
    assert.strictEqual(lo.status, 200);
    assert.strictEqual((await fetch(`${BASE}/mobile/api/me`, { headers: { Cookie: cookie } })).status, 401);
    console.log('  ✓ e2e: request -> verify -> cookie -> /me -> logout revokes');
  }

  // Wrong code over HTTP -> 401.
  {
    const email = uniqEmail(); seedProfile('HttpBad', email);
    const send = capturingSender();
    auth._resetRateLimits();
    await auth.requestOtp(email, { sendMail: send });
    const wrong = send.last().code === '999999' ? '000000' : '999999';
    const res = await fetch(`${BASE}/mobile/api/auth/verify`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, code: wrong }),
    });
    assert.strictEqual(res.status, 401);
    console.log('  ✓ e2e: wrong code -> 401');
  }

  // Existing routes coexist with /mobile.
  {
    assert.strictEqual((await fetch(`${BASE}/health`)).status, 200);
    const conf = await fetch(`${BASE}/configure/`, { headers: { Authorization: adminHeader } });
    assert.strictEqual(conf.status, 200);
    const rootRedirect = await fetch(`${BASE}/`, { headers: { Authorization: adminHeader }, redirect: 'manual' });
    assert.ok(rootRedirect.status === 301 || rootRedirect.status === 302, '/ still redirects to /configure');
    console.log('  ✓ regression: / , /health , /configure coexist with /mobile');
  }

  // ---- Step 2: SPA shell ----
  // GET /mobile/ serves the HTML shell (public — no admin auth), with the exact
  // mobile-first viewport meta and references to app.js + styles.css.
  {
    const res = await fetch(`${BASE}/mobile/`);
    assert.strictEqual(res.status, 200);
    assert.ok((res.headers.get('content-type') || '').includes('text/html'));
    const html = await res.text();
    assert.ok(html.includes('width=device-width, initial-scale=1, viewport-fit=cover'), 'exact viewport meta');
    assert.ok(html.includes('app.js') && html.includes('styles.css') && html.includes('ui.js'));
    console.log('  ✓ shell: GET /mobile/ serves the SPA (public, viewport meta, script refs)');
  }

  // Deep link with no matching file -> SPA fallback returns index.html, not 404.
  {
    const res = await fetch(`${BASE}/mobile/search`);
    assert.strictEqual(res.status, 200);
    const html = await res.text();
    assert.ok(html.includes('viewport-fit=cover'), 'deep link served the shell');
    console.log('  ✓ shell: SPA fallback serves index.html for deep links');
  }

  // Static asset served without Basic Auth, and carries the responsive contract.
  {
    const res = await fetch(`${BASE}/mobile/styles.css`);
    assert.strictEqual(res.status, 200);
    const css = await res.text();
    assert.ok(css.includes('@media (min-width: 768px)'), 'has a desktop breakpoint');
    assert.ok(css.includes('env(safe-area-inset'), 'uses safe-area insets');
    assert.ok(css.includes('max-width'), 'has a max-width container');
    // [hidden] must be enforced with !important, or the ID-specific #view-login
    // display rule out-ranks it and the login screen never actually hides.
    assert.ok(/\[hidden\][^}]*display:\s*none\s*!important/.test(css), 'hidden is enforced with !important');
    console.log('  ✓ shell: styles.css responsive contract + [hidden] enforced');
  }

  // Config endpoint (public) returns app name + version.
  {
    const cfg = await (await fetch(`${BASE}/mobile/api/config`)).json();
    assert.strictEqual(cfg.name, 'AI Recommender');
    assert.strictEqual(cfg.version, require('../../package.json').version);
    console.log('  ✓ shell: /mobile/api/config exposes name + version');
  }

  // Fallback must NOT swallow the API: an unmatched-session data route is still
  // JSON 401, never the HTML shell.
  {
    const res = await fetch(`${BASE}/mobile/api/me`);
    assert.strictEqual(res.status, 401);
    assert.ok((res.headers.get('content-type') || '').includes('application/json'), 'api stays JSON, not HTML');
    console.log('  ✓ shell: SPA fallback does not swallow /mobile/api/*');
  }

  // Per-session API must never be browser-cached (an ETag/304 on /me made login
  // look broken on Chromium/Brave — a 304 surfaces to fetch as not-ok).
  {
    const cfgRes = await fetch(`${BASE}/mobile/api/config`);
    assert.strictEqual(cfgRes.headers.get('cache-control'), 'no-store');
    const meRes = await fetch(`${BASE}/mobile/api/me`);
    assert.strictEqual(meRes.headers.get('cache-control'), 'no-store'); // even on the 401
    // Static bundle is no-store too (no ETag), so a deploy is never masked by a
    // stale cached app.js.
    const jsRes = await fetch(`${BASE}/mobile/app.js`);
    assert.strictEqual(jsRes.headers.get('cache-control'), 'no-store');
    assert.strictEqual(jsRes.headers.get('etag'), null);
    const htmlRes = await fetch(`${BASE}/mobile/`);
    assert.strictEqual(htmlRes.headers.get('cache-control'), 'no-store');
    console.log('  ✓ shell: all /mobile responses (api + static bundle) are no-store, no etag');
  }

  // ---- Step 3: search + watchlist boundaries (no network) ----
  async function sessionCookieFor(email) {
    const send = capturingSender();
    auth._resetRateLimits();
    await auth.requestOtp(email, { sendMail: send });
    const vres = await fetch(`${BASE}/mobile/api/auth/verify`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, code: send.last().code }),
    });
    return (vres.headers.get('set-cookie') || '').split(';')[0];
  }
  {
    // Both routes require a session.
    assert.strictEqual((await fetch(`${BASE}/mobile/api/search?q=batman`)).status, 401);
    assert.strictEqual((await fetch(`${BASE}/mobile/api/watchlist`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 401);
    console.log('  ✓ search/watchlist require a session');

    const email = uniqEmail(); seedProfile('S3 User', email);
    const cookie = await sessionCookieFor(email);

    // Short query -> 400 (before any TMDB call).
    assert.strictEqual((await fetch(`${BASE}/mobile/api/search?q=a`, { headers: { Cookie: cookie } })).status, 400);
    // No TMDB key configured in this test server -> 503 (fail-safe, no network).
    const noKey = await fetch(`${BASE}/mobile/api/search?q=batman&type=movie`, { headers: { Cookie: cookie } });
    assert.strictEqual(noKey.status, 503);
    console.log('  ✓ search: short query -> 400, missing TMDB key -> 503 (no network)');

    // Watchlist: bad body -> 400; valid body but Simkl not connected -> 400.
    const badBody = await fetch(`${BASE}/mobile/api/watchlist`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify({ tmdb_id: '1' }) });
    assert.strictEqual(badBody.status, 400);
    const notConnected = await fetch(`${BASE}/mobile/api/watchlist`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify({ type: 'movie', tmdb_id: '603' }) });
    assert.strictEqual(notConnected.status, 400);
    assert.match((await notConnected.json()).error, /not connected/i);
    console.log('  ✓ watchlist: bad body -> 400, Simkl not connected -> 400');
  }

  // ---- Step 4: recommendations + suppress boundaries ----
  {
    assert.strictEqual((await fetch(`${BASE}/mobile/api/recommendations`)).status, 401);
    assert.strictEqual((await fetch(`${BASE}/mobile/api/recommend/suppress`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 401);
    assert.strictEqual((await fetch(`${BASE}/mobile/api/recommend/unsuppress`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 401);
    console.log('  ✓ recommendations/suppress/unsuppress require a session');

    const email = uniqEmail(); seedProfile('S4 User', email);
    const cookie = await sessionCookieFor(email);
    const recRes = await fetch(`${BASE}/mobile/api/recommendations?type=movie`, { headers: { Cookie: cookie } });
    assert.strictEqual(recRes.status, 200);
    const body = await recRes.json();
    assert.strictEqual(body.type, 'movie');
    assert.ok(Array.isArray(body.items)); // empty pool for a fresh profile — honest empty, not padded
    // suppress with a valid body but nothing to remove still succeeds via the shared path
    const sup = await fetch(`${BASE}/mobile/api/recommend/suppress`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify({ type: 'movie', tmdb_id: '603' }) });
    assert.strictEqual(sup.status, 200);
    console.log('  ✓ recommendations returns items[] for the session profile; suppress works over HTTP');
  }

  // ---- Step 5: settings (editable filters, age gate hidden + immutable) ----
  {
    assert.strictEqual((await fetch(`${BASE}/mobile/api/settings`)).status, 401);
    assert.strictEqual((await fetch(`${BASE}/mobile/api/settings`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 401);
    console.log('  ✓ settings require a session');

    const email = uniqEmail(); const p = seedProfile('S5 User', email);
    config.updateProfile(p.id, { filters: { age_limit: 8 } }); // a kids profile, set in the backend
    const cookie = await sessionCookieFor(email);

    const getBody = await (await fetch(`${BASE}/mobile/api/settings`, { headers: { Cookie: cookie } })).json();
    assert.ok(!('age_limit' in getBody.filters), 'GET never exposes the age gate');
    assert.strictEqual(getBody.catalog_only, true);
    assert.ok(Array.isArray(getBody.genres) && getBody.genres.length > 0);

    // Try to disable the age gate + change a real filter + the view pref in one POST.
    const postRes = await fetch(`${BASE}/mobile/api/settings`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ age_limit: 0, min_rating: 7.5, catalog_only: false }),
    });
    assert.strictEqual(postRes.status, 200);
    const after = config.getProfile(p.id);
    assert.strictEqual(after.filters.age_limit, 8, 'age gate is immutable over HTTP');
    assert.strictEqual(after.filters.min_rating, 7.5);
    assert.strictEqual(after.companion.catalog_only, false);
    console.log('  ✓ settings: GET hides the age gate; POST writes filters/pref but the age gate is immutable');

    // catalog_only now false -> the default recommendations view is the entire list.
    const recBody = await (await fetch(`${BASE}/mobile/api/recommendations?type=movie`, { headers: { Cookie: cookie } })).json();
    assert.strictEqual(recBody.view, 'all');
    console.log('  ✓ recs: default view follows the saved catalog_only pref over HTTP');
  }

  console.log(`\nAll mobile checks passed (${passed} unit + http).`);
  process.exit(0);
}

(async () => { await unitTests(); await httpTests(); })().catch((err) => {
  console.error('\n✗ FAILED:', err.stack || err.message);
  process.exit(1);
});
