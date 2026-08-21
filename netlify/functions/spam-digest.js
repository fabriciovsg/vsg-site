// Twice-daily sweep of the Netlify Forms SPAM list, looking for real enquiries.
//
// Akismet scores the sender as much as the message: IP reputation, VPNs,
// corporate NAT, mailbox history. A customer behind the wrong connection is
// flagged every single time, no matter what they write — and because Netlify
// still returns 200, they see the success message and assume we got it. Three
// enquiries from one customer were lost this way before he phoned.
//
// This does not touch the submit path. It only reads. Worst case it goes quiet
// and we are no worse off than before it existed.
//
// Deliberately stateless: every run reports everything genuine-looking still
// sitting in spam, not just what arrived since last time. Marking a submission
// verified in the Netlify UI removes it from the spam list and therefore from
// this digest, so the list is self-clearing and acting on it is the way to
// silence it. A failed run loses nothing — the next one picks the same items up.

import { sendMail, isEmail, MAIL_SENDER } from '../lib/gmail.js';

const SITE_ID  = process.env.VSG_NETLIFY_SITE_ID || '4276ebb9-7b6e-4889-aad7-c200ccc357e6';
const FORM     = process.env.VSG_FORM_NAME || 'contact';
const API      = 'https://api.netlify.com/api/v1';
const DIGEST_TO = process.env.VSG_DIGEST_TO || MAIL_SENDER;

// How far back to look. Older than this and the lead is cold anyway.
const WINDOW_DAYS = 30;

// ── Scoring ─────────────────────────────────────────────────────────────────
// Tuned to over-include. A false positive here costs one glance at an email;
// a false negative costs a customer who thinks we ignore enquiries.
const TRADE_WORDS = /\b(slab|slabs|stone|marble|granite|quartzite|benchtop|bench top|countertop|kitchen|vanity|splashback|island|honed|polished|leather|thickness|20\s*mm|30\s*mm|quote|quotation|pricing|price|availability|available|m2|m²|square met|sqm)\b/i;
const AU_PHONE    = /(\+?61\s?4\d{2}|\b04\d{2}|\(0[2-8]\)|\b0[2-8]\s?\d{4})[\s\d-]{4,}/;
const LOT_REF     = /lot\s*#/i;
const URLS        = /(https?:\/\/|www\.)/i;

/** Long runs without a vowel — the signature of keyboard-mash spam. */
function looksLikeMash(text) {
  const words = String(text).split(/\s+/).filter(w => w.length > 6);
  if (!words.length) return false;
  const mashy = words.filter(w => !/[aeiou]/i.test(w) || /[bcdfghjklmnpqrstvwxz]{6,}/i.test(w));
  return mashy.length / words.length > 0.4;
}

/** Share of letters outside the Latin block. */
function nonLatinRatio(text) {
  const letters = String(text).match(/\p{L}/gu) || [];
  if (!letters.length) return 0;
  const latin = letters.filter(ch => /\p{Script=Latin}/u.test(ch)).length;
  return 1 - latin / letters.length;
}

function score(sub) {
  const name    = String(sub.name || '');
  const message = String(sub.message || sub.summary || '');
  const stone   = String(sub.stone || '');
  const body    = `${message}\n${stone}`;
  let s = 0;
  const why = [];

  if (LOT_REF.test(body))            { s += 3; why.push('lot reference'); }
  if (TRADE_WORDS.test(body))        { s += 2; why.push('trade language'); }
  if (AU_PHONE.test(`${sub.phone || ''} ${body}`)) { s += 2; why.push('AU phone'); }
  if (isEmail(String(sub.email || '').trim())) { s += 1; why.push('valid email'); }
  if (/^[\p{L}][\p{L}'\u2019-]+(\s+[\p{L}][\p{L}'\u2019-]+)+$/u.test(name.trim())) { s += 1; why.push('real name'); }

  if (URLS.test(body))               { s -= 2; why.push('contains links'); }
  if (nonLatinRatio(body) > 0.3)     { s -= 2; why.push('mostly non-Latin'); }
  if (looksLikeMash(body))           { s -= 3; why.push('keyboard mash'); }

  return { s, why };
}

// ── Netlify Forms API ───────────────────────────────────────────────────────
async function api(path, token) {
  const resp = await fetch(`${API}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!resp.ok) throw new Error(`Netlify API ${resp.status} on ${path}: ${(await resp.text()).slice(0, 200)}`);
  return resp.json();
}

async function spamSubmissions(token) {
  const forms = await api(`/sites/${SITE_ID}/forms`, token);
  const form  = forms.find(f => f.name === FORM) || forms[0];
  if (!form) throw new Error(`no form named "${FORM}" on site ${SITE_ID}`);

  const out = [];
  for (let page = 1; page <= 5; page++) {
    const batch = await api(`/forms/${form.id}/submissions?state=spam&per_page=100&page=${page}`, token);
    if (!Array.isArray(batch) || !batch.length) break;
    out.push(...batch);
    if (batch.length < 100) break;
  }
  return out;
}

/** Submission fields land both at the top level and under `data`. */
function flatten(sub) {
  const d = sub.data || {};
  return {
    id:      sub.id,
    created: sub.created_at,
    name:    sub.name  || d.name  || '',
    email:   sub.email || d.email || '',
    phone:   sub.phone || d.phone || '',
    message: d.message || sub.summary || '',
    stone:   d.stone || '',
  };
}

const melb = (iso) => {
  try {
    return new Intl.DateTimeFormat('en-AU', {
      timeZone: 'Australia/Melbourne', weekday: 'short', day: 'numeric',
      month: 'short', hour: 'numeric', minute: '2-digit',
    }).format(new Date(iso));
  } catch { return iso; }
};

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const stoneCount = (stone) => {
  const val = String(stone || '').trim();
  if (!val) return 0;
  return val.split('|').filter(s => s.trim()).length;
};

function render(likely, borderline) {
  const card = (r) => {
    const n = stoneCount(r.stone);
    return `
    <tr><td style="padding:16px 0;border-bottom:1px solid #E3DCCE">
      <div style="font:600 16px/1.4 Georgia,serif;color:#2B2620">${esc(r.name) || '(no name)'}</div>
      <div style="font:400 13px/1.6 Helvetica,Arial,sans-serif;color:#6B6459;margin-top:3px">
        ${esc(r.email)}${r.phone ? ' &nbsp;·&nbsp; ' + esc(r.phone) : ''} &nbsp;·&nbsp; ${esc(melb(r.created))}
        ${n ? ' &nbsp;·&nbsp; <strong>' + n + ' stone' + (n === 1 ? '' : 's') + '</strong>' : ''}
      </div>
      <div style="margin-top:8px;padding:10px 12px;background:#FAF8F3;border-left:2px solid #B8963C;font:400 13px/1.6 Helvetica,Arial,sans-serif;color:#2B2620;white-space:pre-wrap">${
        esc(String(r.message).slice(0, 600))}${String(r.message).length > 600 ? '…' : ''}</div>
    </td></tr>`;
  };

  const oneLine = (r) => `<li style="margin-bottom:4px">${esc(r.name) || '(no name)'} &nbsp;·&nbsp; ${
    esc(r.email) || 'no email'} &nbsp;·&nbsp; ${esc(melb(r.created))}</li>`;

  return `<!DOCTYPE html><html><head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#F4F1EA">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#F4F1EA">
 <tr><td align="center" style="padding:28px 16px">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="max-width:620px;background:#fff;border:1px solid #E3DCCE">
   <tr><td style="padding:28px 30px">
    <div style="font:400 17px/1.2 Georgia,serif;letter-spacing:.14em;text-transform:uppercase;color:#2B2620">Possible missed enquiries</div>
    <div style="height:2px;width:40px;background:#B8963C;margin:12px 0 18px"></div>
    <div style="font:400 14px/1.6 Helvetica,Arial,sans-serif;color:#2B2620">
      ${likely.length} enquir${likely.length === 1 ? 'y' : 'ies'} in the Netlify spam list look genuine.
      Open <strong>Netlify → Forms → ${esc(FORM)} → Spam submissions</strong> and use
      <strong>Mark as verified</strong> — that recovers the enquiry and stops it appearing here again.
    </div>
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">${likely.map(card).join('')}</table>
    ${borderline.length ? `
    <div style="margin-top:22px;font:600 11px/1.4 Helvetica,Arial,sans-serif;letter-spacing:.12em;text-transform:uppercase;color:#6B6459">Borderline — probably spam, glance only</div>
    <ul style="margin:8px 0 0;padding-left:18px;font:400 13px/1.6 Helvetica,Arial,sans-serif;color:#6B6459">${borderline.map(oneLine).join('')}</ul>` : ''}
    <div style="margin-top:24px;font:400 12px/1.6 Helvetica,Arial,sans-serif;color:#6B6459">
      Sent twice daily. Anything still listed has not been marked verified yet.
    </div>
   </td></tr>
  </table>
 </td></tr>
</table>
</body></html>`;
}

function renderText(likely, borderline) {
  const lines = [`${likely.length} enquir${likely.length === 1 ? 'y' : 'ies'} in the Netlify spam list look genuine.`,
    `Netlify > Forms > ${FORM} > Spam submissions, then "Mark as verified".`, ''];
  likely.forEach(r => {
    const n = stoneCount(r.stone);
    lines.push(`${r.name || '(no name)'}  |  ${r.email}${r.phone ? '  |  ' + r.phone : ''}  |  ${melb(r.created)}${n ? `  |  ${n} stones` : ''}`);
    lines.push(String(r.message).slice(0, 600).replace(/^/gm, '    '), '');
  });
  if (borderline.length) {
    lines.push('Borderline — probably spam:');
    borderline.forEach(r => lines.push(`  ${r.name || '(no name)'} | ${r.email || 'no email'} | ${melb(r.created)}`));
  }
  return lines.join('\n');
}

export default async () => {
  const token = process.env.NETLIFY_API_TOKEN;
  if (!token) {
    console.error('[spam-digest] NETLIFY_API_TOKEN not set — cannot read the spam list');
    return;
  }

  const cutoff = Date.now() - WINDOW_DAYS * 86400_000;
  let raw;
  try {
    raw = await spamSubmissions(token);
  } catch (err) {
    console.error('[spam-digest]', err.message);
    return;
  }

  const rows = raw.map(flatten).filter(r => new Date(r.created).getTime() > cutoff);
  const likely = [], borderline = [];
  for (const r of rows) {
    const { s, why } = score(r);
    if (s >= 3) { likely.push(r); console.log(`[spam-digest] likely genuine: ${r.email} (${s}: ${why.join(', ')})`); }
    else if (s >= 1) borderline.push(r);
  }

  // Silence is the normal case. Only mail when there is something to act on.
  if (!likely.length) {
    console.log(`[spam-digest] ${rows.length} in spam, none look genuine — no email sent`);
    return;
  }

  likely.sort((a, b) => new Date(b.created) - new Date(a.created));
  borderline.sort((a, b) => new Date(b.created) - new Date(a.created));

  await sendMail({
    to: DIGEST_TO,
    subject: `${likely.length} possible missed enquir${likely.length === 1 ? 'y' : 'ies'} in spam`,
    text: renderText(likely, borderline.slice(0, 15)),
    html: render(likely, borderline.slice(0, 15)),
  });
  console.log(`[spam-digest] digest sent: ${likely.length} likely, ${borderline.length} borderline`);
};

// 22:30 and 04:30 UTC — 8:30am and 2:30pm in Melbourne during AEST, 9:30am and
// 3:30pm during AEDT. Cron is UTC-only, so daylight saving shifts both by an
// hour; these times were picked so that both stay inside trading hours either
// way. Netlify allows one schedule per function, but cron lists give us two runs.
export const config = { schedule: '30 4,22 * * *' };
