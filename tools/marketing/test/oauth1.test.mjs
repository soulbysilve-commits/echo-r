import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { percentEncode, buildSignatureBaseString, buildOAuth1Header } from '../connectors/oauth1.mjs';

// Every value below is independently checked against RFC 5849 §3.4.1's own
// worked parameter-normalization example (fetched and cross-checked by hand,
// value by value, including the tricky double-percent-encoded b5=%3D%253D
// case and the c%40 vs c2 sort-order tie-break) — this is the part of OAuth1
// signing that's actually easy to get subtly wrong. The duplicate `a3` key
// from the RFC example is omitted here because this codebase's params are a
// plain object (X's API never needs a repeated query key for our use), but
// every other value/encoding rule from that example is preserved exactly.

test('percentEncode matches RFC 3986 unreserved-character rules used by OAuth1', () => {
  assert.equal(percentEncode('r b'), 'r%20b');
  assert.equal(percentEncode('=%3D'), '%3D%253D'); // value itself contains a literal % and =
  assert.equal(percentEncode('c@'), 'c%40');
  assert.equal(percentEncode(''), '');
  assert.equal(percentEncode('9djdj82h48djs9d2'), '9djdj82h48djs9d2');
});

test('buildSignatureBaseString reproduces the RFC 5849 §3.4.1 normalization order and encoding', () => {
  const params = {
    a2: 'r b',
    b5: '=%3D',
    'c@': '',
    c2: '',
    oauth_consumer_key: '9djdj82h48djs9d2',
    oauth_nonce: '7d8f3e4a',
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: '137131201',
    oauth_token: 'kkk9d7dh3k39sjv7',
  };
  const base = buildSignatureBaseString('POST', 'http://example.com/request', params);
  const expected =
    'POST&http%3A%2F%2Fexample.com%2Frequest&' +
    'a2%3Dr%2520b%26b5%3D%253D%25253D%26c%2540%3D%26c2%3D%26' +
    'oauth_consumer_key%3D9djdj82h48djs9d2%26oauth_nonce%3D7d8f3e4a%26' +
    'oauth_signature_method%3DHMAC-SHA1%26oauth_timestamp%3D137131201%26' +
    'oauth_token%3Dkkk9d7dh3k39sjv7';
  assert.equal(base, expected);
});

test('buildOAuth1Header produces a deterministic HMAC-SHA1 signature over its own (verified-correct) base string', () => {
  const credentials = {
    consumerKey: 'ck', consumerSecret: 'cs',
    accessToken: 'at', accessTokenSecret: 'ats',
  };
  const header = buildOAuth1Header('POST', 'https://api.twitter.com/2/tweets', credentials, {
    nonce: 'fixednonce', timestamp: '1000000000',
  });
  const expectedBase = buildSignatureBaseString('POST', 'https://api.twitter.com/2/tweets', {
    oauth_consumer_key: 'ck', oauth_nonce: 'fixednonce', oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: '1000000000', oauth_token: 'at', oauth_version: '1.0',
  });
  const expectedSig = createHmac('sha1', `${percentEncode('cs')}&${percentEncode('ats')}`).update(expectedBase).digest('base64');
  assert.ok(header.includes(`oauth_signature="${percentEncode(expectedSig)}"`));
  assert.ok(header.startsWith('OAuth '));
});

test('signature changes if any signed parameter changes', () => {
  const credentials = { consumerKey: 'ck', consumerSecret: 'cs', accessToken: 'at', accessTokenSecret: 'ats' };
  const h1 = buildOAuth1Header('POST', 'https://api.twitter.com/2/tweets', credentials, { nonce: 'n', timestamp: '1' });
  const h2 = buildOAuth1Header('POST', 'https://api.twitter.com/2/tweets', credentials, { nonce: 'n2', timestamp: '1' });
  assert.notEqual(h1, h2);
});
