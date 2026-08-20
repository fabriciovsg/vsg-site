// VSG — outbound mail from Netlify Functions, sent through Gmail as a real
// mailbox rather than a third-party relay.
//
// The service account impersonates VSG_MAIL_SENDER via domain-wide delegation,
// so the message is genuinely sent BY that Workspace user: it appears in their
// Sent folder, it passes SPF/DKIM/DMARC on the Google records already in the
// zone, and a customer's reply threads into the normal inbox. No new vendor,
// no new DNS records, nothing to keep paying for.
//
// One-time setup (see SETUP.md):
//   1. Enable the Gmail API in the same Google Cloud project. Drive being
//      enabled is not enough — each API is enabled separately.
//   2. Workspace Admin → Security → Access and data control → API controls →
//      Domain-wide delegation. Add the service account's NUMERIC client ID
//      (not its email) with scope https://www.googleapis.com/auth/gmail.send.
//   3. Set VSG_MAIL_SENDER, scoped to Functions, to a real mailbox.
//
// Delegation is granted per scope, and gmail.send is send-only: it cannot
// read, search or delete a single message in any mailbox in the domain.

import { getAccessToken, GMAIL_SEND_SCOPE } from './google.js';

const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1';

export const MAIL_SENDER    = process.env.VSG_MAIL_SENDER    || 'sales@victoriastonegallery.com.au';
export const MAIL_FROM_NAME = process.env.VSG_MAIL_FROM_NAME || 'Victoria Stone Gallery';

// Deliberately strict. Anything this rejects simply doesn't get a confirmation;
// the enquiry itself is already safely banked with Netlify either way.
const EMAIL_RE = /^[^\s@,;<>"']+@[^\s@,;<>"']+\.[a-z]{2,}$/i;

export function isEmail(addr) {
  return typeof addr === 'string' && addr.length <= 254 && EMAIL_RE.test(addr.trim());
}

function b64url(buf) {
  return Buffer.from(buf).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Base64 body, wrapped at 76 chars per RFC 2045. Sidesteps every quoted-printable
// edge case with the em-dashes and × signs that run through the stone copy.
function b64body(text) {
  return Buffer.from(text, 'utf8').toString('base64').replace(/(.{76})/g, '$1\r\n');
}

/**
 * A display name safe to drop into a header.
 *
 * The customer's own name goes in the To: header, so this is untrusted input:
 * a bare CR/LF here would let someone inject extra headers (a Bcc, say) into
 * mail sent from our domain. Newlines are stripped first, then non-ASCII is
 * RFC 2047 encoded and ASCII specials are quoted.
 */
function displayName(raw) {
  const clean = String(raw || '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/["\\]/g, '')
    .trim()
    .slice(0, 80);
  if (!clean) return '';
  if (!/^[\x20-\x7E]*$/.test(clean)) {
    return `=?UTF-8?B?${Buffer.from(clean, 'utf8').toString('base64')}?=`;
  }
  return /[(),:;<>@[\]]/.test(clean) ? `"${clean}"` : clean;
}

function address(email, name) {
  const dn = displayName(name);
  return dn ? `${dn} <${email}>` : email;
}

function subjectHeader(raw) {
  const clean = String(raw || '').replace(/[\r\n\t]+/g, ' ').trim();
  return /^[\x20-\x7E]*$/.test(clean)
    ? clean
    : `=?UTF-8?B?${Buffer.from(clean, 'utf8').toString('base64')}?=`;
}

/**
 * Send one message as MAIL_SENDER.
 *
 * Throws on failure — callers decide whether that matters. For the enquiry
 * confirmation it does not: the enquiry is already recorded, and a failed
 * courtesy email must never look like a failed enquiry.
 */
export async function sendMail({ to, toName = '', subject, text, html, replyTo = MAIL_SENDER, bcc = '' }) {
  if (!isEmail(to)) throw new Error('sendMail: invalid recipient');

  const token = await getAccessToken(GMAIL_SEND_SCOPE, MAIL_SENDER);
  const boundary = `vsg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

  const headers = [
    `From: ${address(MAIL_SENDER, MAIL_FROM_NAME)}`,
    `To: ${address(to.trim(), toName)}`,
    `Reply-To: ${replyTo}`,
    ...(isEmail(bcc) ? [`Bcc: ${bcc}`] : []),
    `Subject: ${subjectHeader(subject)}`,
    // Marks this as machine-generated so other autoresponders don't answer it.
    // Without it, two out-of-office robots can talk to each other indefinitely.
    'Auto-Submitted: auto-replied',
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
  ];

  const mime = [
    headers.join('\r\n'),
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    b64body(text),
    `--${boundary}`,
    'Content-Type: text/html; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    b64body(html),
    `--${boundary}--`,
    '',
  ].join('\r\n');

  const resp = await fetch(`${GMAIL_API}/users/me/messages/send`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ raw: b64url(mime) }),
  });

  if (!resp.ok) {
    // Google's error body names the scope and the impersonated user, which is
    // exactly what you need in the function log when delegation isn't right.
    const detail = await resp.text().catch(() => '');
    throw new Error(`Gmail send failed (${resp.status}) ${detail.slice(0, 300)}`);
  }
  return await resp.json().catch(() => ({}));
}
