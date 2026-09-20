// OAuth 1.0a request signing (RFC 5849 / HMAC-SHA1), used by the X connector.
// X's v2 API still accepts OAuth 1.0a user-context signing for a single
// known account's long-lived access token, which avoids needing a browser-
// based OAuth2 authorization dance for a server-side bot account.
import { createHmac, randomBytes } from 'node:crypto';

export function percentEncode(str) {
  return encodeURIComponent(str).replace(/[!*'()]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

export function buildSignatureBaseString(method, url, params) {
  // RFC 5849 §3.4.1.3.2: sort by the *percent-encoded* key (and, for a tied
  // key, the percent-encoded value) — not the raw key. E.g. encoded "c%40"
  // must sort before "c2" even though raw "c@" sorts after raw "c2".
  const encodedPairs = Object.keys(params).map((key) => [percentEncode(key), percentEncode(params[key])]);
  encodedPairs.sort(([ka, va], [kb, vb]) => (ka < kb ? -1 : ka > kb ? 1 : va < vb ? -1 : va > vb ? 1 : 0));
  const sortedParams = encodedPairs.map(([k, v]) => `${k}=${v}`).join('&');
  return [method.toUpperCase(), percentEncode(url), percentEncode(sortedParams)].join('&');
}

export function generateNonce() {
  return randomBytes(16).toString('hex');
}

/**
 * Returns the value for an `Authorization: OAuth ...` header.
 * `credentials` = { consumerKey, consumerSecret, accessToken, accessTokenSecret }
 * `queryParams` (optional) must be included in the signature base string for GET requests.
 */
export function buildOAuth1Header(method, url, credentials, { queryParams = {}, nonce, timestamp } = {}) {
  const oauthParams = {
    oauth_consumer_key: credentials.consumerKey,
    oauth_nonce: nonce ?? generateNonce(),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: timestamp ?? String(Math.floor(Date.now() / 1000)),
    oauth_token: credentials.accessToken,
    oauth_version: '1.0',
  };

  const allParams = { ...queryParams, ...oauthParams };
  const baseString = buildSignatureBaseString(method, url, allParams);
  const signingKey = `${percentEncode(credentials.consumerSecret)}&${percentEncode(credentials.accessTokenSecret)}`;
  const signature = createHmac('sha1', signingKey).update(baseString).digest('base64');

  const headerParams = { ...oauthParams, oauth_signature: signature };
  const header = 'OAuth ' + Object.keys(headerParams)
    .sort()
    .map((key) => `${percentEncode(key)}="${percentEncode(headerParams[key])}"`)
    .join(', ');
  return header;
}
