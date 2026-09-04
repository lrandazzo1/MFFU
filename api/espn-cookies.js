/* ============================================================
   ESPN COOKIE SANITIZER / SERIALIZER  —  shared by api/espn.js and api/league.js

   Private-league reads authenticate with the two cookies a logged-in ESPN
   browser holds: SWID and espn_s2. Readers do not paste bare values — they
   paste whatever the clipboard gave them, and every one of these shapes has
   been seen for a credential that is otherwise perfectly valid:

     {ABC12345-...}                 the ideal paste
     ABC12345-...                   braces dropped by the copy
     %7BABC12345-...%7D             URL-encoded braces
     SWID={ABC12345-...}            the whole DevTools "name=value" row
     "AEBxyz..."                    DevTools "Copy value" quotes the string
     SWID={ABC...}; espn_s2=AEB...  a document.cookie / "Copy all" paste
     AEBxyz...;                     a trailing separator from a row copy
     AEBxy\nz...                    the DevTools cookie panel WRAPS long values

   The last shape is the quiet killer: a newline in a header value makes
   fetch() throw before a request is made, which every caller reads as a
   network outage rather than a credential problem.

   The same normalisation has to exist on the server as in the browser, because
   two credential sources never pass through the browser at all: cookies
   decrypted out of public.leagues (whatever an older build stored) and the
   deployment-wide ESPN_S2 / ESPN_SWID environment variables, which are pasted
   by hand into a dashboard field.

   Deterministic string surgery only — no randomness, no clock, no network.
============================================================ */

// Visible ASCII minus ';' — the only octets legal in a cookie-pair value.
const COOKIE_SAFE_RE = /^[\x21-\x3A\x3C-\x7E]+$/;

const COOKIE_NAMES = { espn_s2: 'espn_s2', swid: 'SWID' };

/* Returns the transmittable value, or '' with a reason on `.reason` via
   inspectCookieValue. Callers that only want the value use this. */
function sanitizeCookieValue(name, raw) {
  return inspectCookieValue(name, raw).value;
}

/* Full inspection so callers can log a real cause instead of "auth failed". */
function inspectCookieValue(name, raw) {
  const cookieName = String(name).toLowerCase() === 'swid' ? 'SWID' : 'espn_s2';
  const original = String(raw == null ? '' : raw);
  const out = { name: cookieName, value: '', present: false, ok: true, reason: '' };

  let v = original.replace(/^﻿/, '').trim();
  if (!v) return out;
  out.present = true;

  /* A "name=value" row, or a whole cookie jar, pasted wholesale. Only a pair
     at the start of the string or after a ';' counts as a name separator, so
     an '=' inside a URL-encoded espn_s2 body can never be mistaken for one. */
  const pair = new RegExp('(?:^|;)\\s*' + cookieName + '\\s*=\\s*([^;]*)', 'i').exec(v);
  if (pair) v = pair[1];

  /* DevTools' "Copy value" wraps the string in quotes often enough to be worth
     peeling — twice, for a value quoted on the way into a notes app and again
     on the way out. */
  v = v.trim();
  for (let i = 0; i < 2; i++) {
    const quoted = /^(["'])([\s\S]*)\1$/.exec(v);
    if (!quoted) break;
    v = quoted[2].trim();
  }

  /* Drop a trailing separator, then every whitespace and control character.
     ESPN cookie values contain neither, so anything here came from the copy
     and would make the value untransmittable if it survived. */
  v = v.replace(/;+\s*$/, '').replace(/[\s ]+/g, '').replace(/[\x00-\x1f\x7f]+/g, '');

  if (cookieName === 'SWID') {
    /* Braces are part of the value ESPN sets. Accept the paste with them,
       without them, or percent-encoded, and always emit the canonical
       brace-wrapped form. espn_s2 is deliberately NOT decoded — it is
       URL-encoded by design and ESPN expects it back verbatim. */
    v = v.replace(/%7B/gi, '{').replace(/%7D/gi, '}');
    v = v.replace(/^\{+/, '').replace(/\}+$/, '');
    if (v) v = '{' + v + '}';
  }

  if (!v) {
    out.ok = false;
    out.reason = 'the pasted ' + cookieName +
      ' held no usable value once the cookie name, quotes and whitespace were stripped';
    return out;
  }
  if (!COOKIE_SAFE_RE.test(v)) {
    out.ok = false;
    out.reason = 'the ' + cookieName +
      ' value contains characters that cannot be sent in a cookie header ' +
      '(a stray ";" or a non-ASCII character from the paste)';
    return out;
  }

  out.value = v;
  return out;
}

/* Serialize a credential pair into the exact Cookie header ESPN expects:
     SWID={XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX}; espn_s2=AEB...
   SWID leads because that is the order a logged-in ESPN browser sends.
   Returns the sanitized parts alongside the header so a caller can report
   exactly which credential was dropped. */
function buildEspnCookieHeader(swidRaw, s2Raw) {
  const swid = inspectCookieValue('SWID', swidRaw);
  const s2 = inspectCookieValue('espn_s2', s2Raw);
  const parts = [];
  if (swid.value) parts.push('SWID=' + swid.value);
  if (s2.value) parts.push('espn_s2=' + s2.value);
  const faults = [swid, s2].filter(function (entry) { return entry.present && !entry.ok; });
  return {
    header: parts.join('; '),
    swid: swid.value,
    espn_s2: s2.value,
    count: parts.length,
    faults: faults,
    reason: faults.map(function (f) { return f.reason; }).join('; '),
  };
}

module.exports = {
  COOKIE_NAMES,
  sanitizeCookieValue,
  inspectCookieValue,
  buildEspnCookieHeader,
};
