// Brevo email over the SMTP relay (smtp-relay.brevo.com) via nodemailer.
// (Decided 2026-08-26: use Brevo's SMTP relay, matching the xsmtpsib- SMTP key.)
//
// Credentials are infrastructure secrets in ENV, handled like ADMIN_PASSWORD —
// never per-profile, never committed:
//   BREVO_SMTP_LOGIN  the SMTP username (Brevo dashboard → SMTP & API → SMTP)
//   BREVO_SMTP_KEY    the SMTP key (xsmtpsib-…) used as the SMTP password
//                     (BREVO_API_KEY is still accepted as an alias for the password)
//   BREVO_SMTP_HOST   default smtp-relay.brevo.com
//   BREVO_SMTP_PORT   default 587 (STARTTLS); 465 switches to implicit TLS
//   MOBILE_MAIL_FROM  the From address (a Brevo-verified sender)
//
// With mail unconfigured, sendOtpEmail logs the code to the server console and
// does NOT send — so local/dev and the whole test suite stay offline.
const nodemailer = require('nodemailer');

const smtpHost = () => process.env.BREVO_SMTP_HOST || 'smtp-relay.brevo.com';
const smtpPort = () => parseInt(process.env.BREVO_SMTP_PORT || '587', 10);
const smtpLogin = () => process.env.BREVO_SMTP_LOGIN || '';
const smtpKey = () => process.env.BREVO_SMTP_KEY || process.env.BREVO_API_KEY || '';
const mailFrom = () => process.env.MOBILE_MAIL_FROM || '';

// Mail is usable only with a login, a password, and a From address.
function mailConfigured() {
  return !!(smtpLogin() && smtpKey() && mailFrom());
}

// Lazy singleton transporter. Reset in tests via _reset().
let _transporter = null;
function transporter() {
  if (_transporter) return _transporter;
  _transporter = nodemailer.createTransport({
    host: smtpHost(),
    port: smtpPort(),
    secure: smtpPort() === 465, // 465 = implicit TLS; 587 = STARTTLS (secure:false)
    auth: { user: smtpLogin(), pass: smtpKey() },
  });
  return _transporter;
}
function _reset() { _transporter = null; }

// PURE: build the nodemailer message object for a one-time code. Exported so
// tests can assert the shape without sending anything.
function buildOtpMessage({ to, from, fromName = 'AI Recommender', code, ttlMinutes = 60, appUrl = '' }) {
  const subject = `Your sign-in code: ${code}`;
  const text = `Your AI Recommender sign-in code is ${code}. `
    + `It expires in ${ttlMinutes} minutes and can be used once.`
    + (appUrl ? `\n\nSign in at ${appUrl}` : '');
  const linkHtml = appUrl
    ? `<p style="color:#8b91a3;font-size:13px;margin-top:20px">Sign in at <a href="${appUrl}" style="color:#8b5cf6">${appUrl}</a></p>`
    : '';
  const html = `<!doctype html><html><body style="margin:0;font-family:system-ui,-apple-system,'Segoe UI',sans-serif;background:#0f1117;color:#e6e8ee;padding:28px">
    <h2 style="margin:0 0 4px;font-size:18px">Your sign-in code</h2>
    <p style="color:#8b91a3;font-size:13px;margin:0 0 16px">AI Recommender companion app</p>
    <p style="font-size:34px;font-weight:700;letter-spacing:8px;margin:0 0 12px">${code}</p>
    <p style="color:#8b91a3;font-size:13px;margin:0">Expires in ${ttlMinutes} minutes · single use.</p>
    ${linkHtml}
  </body></html>`;
  return { from: { name: fromName || 'AI Recommender', address: from }, to, subject, text, html };
}

// Verify the SMTP connection + auth WITHOUT sending anything (nodemailer's
// transporter.verify()). Returns { ok:true } | { ok:false, reason }.
async function verifyTransport() {
  if (!mailConfigured()) return { ok: false, reason: 'mail not configured (need BREVO_SMTP_LOGIN, BREVO_SMTP_KEY, MOBILE_MAIL_FROM)' };
  try {
    await transporter().verify();
    return { ok: true, host: smtpHost(), port: smtpPort(), login: smtpLogin() };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

// Send an OTP email. `send` is injectable for tests (default: the real SMTP
// transporter's sendMail). Returns { sent:true, id } | { sent:false, dev:true }.
async function sendOtpEmail({ to, code, ttlMinutes = 60, appUrl = '' }, send = defaultSend) {
  if (!mailConfigured()) {
    console.log(`[mobile] (mail not configured — set BREVO_SMTP_LOGIN + BREVO_SMTP_KEY + MOBILE_MAIL_FROM) OTP for ${to}: ${code}`);
    return { sent: false, dev: true };
  }
  const msg = buildOtpMessage({ to, from: mailFrom(), fromName: process.env.MOBILE_MAIL_FROM_NAME, code, ttlMinutes, appUrl });
  const info = await send(msg);
  // Debug: dump exactly what the transport returned, then a concise success line.
  // This is Brevo's SMTP relay (nodemailer), so the "OK" is the SMTP 250 reply in
  // `info.response` — the equivalent of an HTTP 200 for the API path.
  console.log('[mobile] BREVO RESPONSE:', info);
  console.log(`[mobile] BREVO: OTP email sent to ${to}, OK — ${(info && info.response) || 'accepted'}${info && info.messageId ? ` (messageId ${info.messageId})` : ''}`);
  return { sent: true, id: info?.messageId };
}

async function defaultSend(msg) { return transporter().sendMail(msg); }

module.exports = {
  buildOtpMessage, sendOtpEmail, verifyTransport, mailConfigured, defaultSend,
  smtpHost, smtpPort, smtpLogin, _reset,
};
