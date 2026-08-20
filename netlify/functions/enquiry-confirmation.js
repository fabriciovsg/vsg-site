// Sends the customer a copy of their own enquiry, as sales@, via Gmail.
//
// Triggered by Netlify's `formSubmitted` event, which fires only AFTER a
// submission has been verified and stored. Three things follow from that:
//
//   1. The enquiry is already safe. Nothing in this file can lose one, so
//      every failure path here is a silent log-and-return, never a throw that
//      might read as a broken form.
//   2. Netlify's spam filtering and the honeypot have already run, so this is
//      not an open relay — a bot cannot use the form to mail arbitrary people.
//   3. It runs out-of-band, so a slow Gmail call costs the visitor nothing.
//
// The confirmation is a trust signal as much as a receipt: it lists the lots
// back to the customer, and because it is sent as a real Workspace message it
// gives them a thread to reply into rather than a no-reply dead end.
//
// COPY AND CONTACT DETAILS COME FROM vsg-site-config.json, so the admin panel
// edits this email the same way it edits the site. FALLBACK below is used only
// when Drive can't be read — a config hiccup costs the custom wording, never
// the email.

import { driveReadText, SITE_CONFIG_FILE_ID } from '../lib/google.js';
import { sendMail, isEmail, MAIL_SENDER } from '../lib/gmail.js';

// ── Fallback copy ───────────────────────────────────────────────────────────
// The admin panel's "Reset to Defaults" restores exactly these strings, so
// these and CMS_DEFAULTS in index.html must be kept in step.
const FALLBACK = {
  opening: 'Thank you for getting in touch. Your enquiry has reached our team and we\u2019ll come back to you shortly \u2014 usually within one business day.',
  closing: 'If any of this looks wrong, simply reply to this email \u2014 it comes straight back to us.',
  visit:   'You\u2019re also very welcome to visit the gallery and see the slabs in person. Every slab is unique, and photographs only go so far.',
  address: '37\u201339 Gaine Road<br>Dandenong South VIC 3175',
  phone:   '03 9702 7539',
  email:   'sales@victoriastonegallery.com.au',
  hours:   '',
};

// Not editable: labels and furniture, not copy anyone wants to rewrite, and
// every extra field is another row to scroll past in the panel.
const FIXED = {
  subject:      'We\u2019ve received your enquiry \u2014 Victoria Stone Gallery',
  subjectStone: 'Your stone enquiry \u2014 Victoria Stone Gallery',
  stonesLabel:  'The stone you asked about',
  stonesLabelP: 'The stones you asked about',
  messageLabel: 'Your message',
  hoursLabel:   'Opening hours',
  signoff:      'Victoria Stone Gallery',
  site:         'victoriastonegallery.com.au',
  siteHref:     'https://victoriastonegallery.com.au',
};

const GOLD = '#B8963C';
const INK  = '#2B2620';
const MUTE = '#6B6459';
const RULE = '#E3DCCE';

// ── Config ──────────────────────────────────────────────────────────────────
// Cached in module scope, so a burst of enquiries on one warm instance costs
// one Drive read rather than one per message.
const CFG_TTL   = 5 * 60 * 1000;
const CFG_RETRY = 60 * 1000;
let _cfg = null, _cfgAt = 0, _cfgTry = 0;

async function siteConfig() {
  const now = Date.now();
  if (_cfg && now - _cfgAt < CFG_TTL) return _cfg;
  // Don't hammer Drive while it's unhappy; serve the last good copy, or none.
  if (now - _cfgTry < CFG_RETRY) return _cfg || {};
  _cfgTry = now;
  try {
    const parsed = JSON.parse(await driveReadText(SITE_CONFIG_FILE_ID));
    if (parsed && typeof parsed === 'object') { _cfg = parsed; _cfgAt = now; }
  } catch (err) {
    console.warn('[enquiry-confirmation] config unreadable, using fallback copy:',
      err && err.message ? err.message : err);
  }
  return _cfg || {};
}

const pick = (cfg, key, fallback) => {
  const v = cfg && typeof cfg[key] === 'string' ? cfg[key].trim() : '';
  return v || fallback;
};

// ── Text handling ───────────────────────────────────────────────────────────
const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

/**
 * CMS fields are allowed to carry light markup — `address` ships with a <br>
 * and the panel labels several fields "HTML ok". Escape everything, then
 * re-admit a short whitelist plus intact entities. Escape-then-readmit rather
 * than blacklist: anything not named here cannot survive by accident.
 */
function safeHtml(raw) {
  return esc(raw)
    .replace(/&lt;(\/?)(br|em|strong|b|i)\s*\/?&gt;/gi, (m, slash, tag) => `<${slash}${tag.toLowerCase()}>`)
    .replace(/&amp;(#\d{1,6}|#x[0-9a-f]{1,6}|[a-z]{2,8});/gi, '&$1;');
}

/** The plain-text alternative of a CMS field. */
function toText(raw) {
  return String(raw || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&#(\d{1,6});/g, (m, d) => String.fromCodePoint(+d))
    .replace(/&#x([0-9a-f]{1,6});/gi, (m, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&quot;/gi, '"').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&')
    .trim();
}

const telHref = (phone) => 'tel:' + String(phone || '').replace(/[^\d+]/g, '');

/**
 * The hidden `stone` field carries either one stone or a whole shortlist.
 * enquireAboutShortlist() joins its numbered lines with ' | '; the single-stone
 * path writes one unnumbered line. Both collapse to a plain list here.
 */
function parseStones(raw) {
  const val = String(raw || '').trim();
  if (!val) return [];
  return val.split('|')
    .map(s => s.trim().replace(/^\d+\.\s*/, ''))
    .filter(Boolean)
    .slice(0, 40);
}

function firstName(full) {
  const n = String(full || '').trim().split(/\s+/)[0] || '';
  return /^[\p{L}'\u2019-]{1,30}$/u.test(n) ? n : '';
}

function resolve(cfg) {
  return {
    opening: pick(cfg, 'emailConfirmOpening', FALLBACK.opening),
    closing: pick(cfg, 'emailConfirmClosing', FALLBACK.closing),
    visit:   pick(cfg, 'emailConfirmVisit',   FALLBACK.visit),
    // Shared with the site's contact section — one place for all of it, which
    // is why hours can safely appear here at all.
    address: pick(cfg, 'address', FALLBACK.address),
    phone:   pick(cfg, 'phone',   FALLBACK.phone),
    email:   pick(cfg, 'email',   FALLBACK.email),
    hours:   pick(cfg, 'hours',   FALLBACK.hours),
  };
}

function buildText({ name, stones, message, c }) {
  const hi = firstName(name) ? `Hi ${firstName(name)},` : 'Hello,';
  const out = [hi, '', toText(c.opening), ''];
  if (stones.length) {
    out.push((stones.length === 1 ? FIXED.stonesLabel : FIXED.stonesLabelP) + ':', '');
    stones.forEach(s => out.push(`  \u2022 ${s}`));
    out.push('');
  }
  if (message) out.push(`${FIXED.messageLabel}:`, '', message, '');
  out.push(toText(c.closing), '', toText(c.visit), '', '\u2014', FIXED.signoff, toText(c.address));
  if (c.hours) out.push('', `${FIXED.hoursLabel}:`, toText(c.hours));
  out.push('', toText(c.phone), toText(c.email), FIXED.siteHref);
  return out.join('\n');
}

function buildHtml({ name, stones, message, c }) {
  const hi = firstName(name) ? `Hi ${esc(firstName(name))},` : 'Hello,';

  const stoneBlock = stones.length ? `
      <tr><td style="padding:26px 0 0">
        <div style="font:600 11px/1.4 Helvetica,Arial,sans-serif;letter-spacing:.14em;text-transform:uppercase;color:${MUTE}">${
          stones.length === 1 ? FIXED.stonesLabel : FIXED.stonesLabelP}</div>
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin-top:12px;border-collapse:collapse">
          ${stones.map(s => `<tr><td style="padding:9px 0;border-bottom:1px solid ${RULE};font:400 16px/1.45 Georgia,'Times New Roman',serif;color:${INK}">${esc(s)}</td></tr>`).join('')}
        </table>
      </td></tr>` : '';

  const messageBlock = message ? `
      <tr><td style="padding:26px 0 0">
        <div style="font:600 11px/1.4 Helvetica,Arial,sans-serif;letter-spacing:.14em;text-transform:uppercase;color:${MUTE}">${FIXED.messageLabel}</div>
        <div style="margin-top:10px;padding:14px 16px;background:#FAF8F3;border-left:2px solid ${GOLD};font:400 15px/1.6 Helvetica,Arial,sans-serif;color:${INK};white-space:pre-wrap">${esc(message)}</div>
      </td></tr>` : '';

  const hoursBlock = c.hours
    ? `<div style="margin-top:10px"><span style="color:${INK}">${FIXED.hoursLabel}</span><br>${safeHtml(c.hours)}</div>`
    : '';

  // Table-based, inline styles, no images and no web fonts: the layout that
  // survives Outlook, Gmail clipping and dark-mode inversion without fuss.
  return `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#F4F1EA">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#F4F1EA">
 <tr><td align="center" style="padding:32px 16px">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="max-width:560px;background:#FFFFFF;border:1px solid ${RULE}">
   <tr><td style="padding:34px 34px 0">
     <div style="font:400 19px/1.2 Georgia,'Times New Roman',serif;letter-spacing:.16em;text-transform:uppercase;color:${INK}">Victoria Stone Gallery</div>
     <div style="height:2px;width:44px;background:${GOLD};margin:14px 0 0"></div>
   </td></tr>
   <tr><td style="padding:0 34px 34px">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
      <tr><td style="padding:26px 0 0;font:400 17px/1.5 Georgia,'Times New Roman',serif;color:${INK}">${hi}</td></tr>
      <tr><td style="padding:12px 0 0;font:400 15px/1.65 Helvetica,Arial,sans-serif;color:${INK}">${safeHtml(c.opening)}</td></tr>
      ${stoneBlock}
      ${messageBlock}
      <tr><td style="padding:26px 0 0;font:400 15px/1.65 Helvetica,Arial,sans-serif;color:${INK}">${safeHtml(c.closing)}</td></tr>
      <tr><td style="padding:14px 0 0;font:400 15px/1.65 Helvetica,Arial,sans-serif;color:${INK}">${safeHtml(c.visit)}</td></tr>
      <tr><td style="padding:28px 0 0"><div style="height:1px;background:${RULE}"></div></td></tr>
      <tr><td style="padding:18px 0 0;font:400 13px/1.75 Helvetica,Arial,sans-serif;color:${MUTE}">
        <div style="color:${INK};font-weight:600">${FIXED.signoff}</div>
        ${safeHtml(c.address)}
        ${hoursBlock}
        <div style="margin-top:10px">
          <a href="${esc(telHref(c.phone))}" style="color:${MUTE};text-decoration:none">${esc(toText(c.phone))}</a><br>
          <a href="mailto:${esc(toText(c.email))}" style="color:${GOLD};text-decoration:none">${esc(toText(c.email))}</a><br>
          <a href="${FIXED.siteHref}" style="color:${GOLD};text-decoration:none">${FIXED.site}</a>
        </div>
      </td></tr>
    </table>
   </td></tr>
  </table>
 </td></tr>
</table>
</body></html>`;
}

export default {
  async formSubmitted(event) {
    try {
      const d = event && event.data ? event.data : {};

      // Only the contact form. `form-name` isn't guaranteed to survive into the
      // event payload, so its ABSENCE is tolerated — but if it's present and
      // names some other form, this is not ours to answer.
      const formName = d['form-name'];
      if (formName && formName !== 'contact') return;

      // Belt and braces behind Netlify's own filtering.
      if (d['bot-field']) return;

      const to = String(d.email || '').trim();
      if (!isEmail(to)) {
        console.warn('[enquiry-confirmation] skipped: no usable email address');
        return;
      }

      // Never answer ourselves — a submission from the sending mailbox would
      // otherwise be a loop with a delivery receipt on the end of it.
      if (to.toLowerCase() === MAIL_SENDER.toLowerCase()) return;

      const stones  = parseStones(d.stone);
      const message = String(d.message || '').trim().slice(0, 4000);
      const name    = d.name || '';
      const c       = resolve(await siteConfig());

      await sendMail({
        to,
        toName: name,
        subject: stones.length ? FIXED.subjectStone : FIXED.subject,
        text: buildText({ name, stones, message, c }),
        html: buildHtml({ name, stones, message, c }),
        replyTo: isEmail(toText(c.email)) ? toText(c.email) : MAIL_SENDER,
        bcc: process.env.VSG_MAIL_BCC || '',
      });

      console.log(`[enquiry-confirmation] sent to ${to} (${stones.length} stone${stones.length === 1 ? '' : 's'})`);
    } catch (err) {
      // Swallowed on purpose. The enquiry is already stored and sales@ has
      // already been notified by Netlify; a failed courtesy copy is a log line,
      // not an incident.
      console.error('[enquiry-confirmation]', err && err.message ? err.message : err);
    }
  },
};
