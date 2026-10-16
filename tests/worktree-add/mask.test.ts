import assert from 'node:assert/strict';
import { test } from 'node:test';

import { maskSecrets } from '../../src/worktree-add/mask.ts';

await test('maskSecrets keeps the URL user and hides the password', () => {
    const text = 'GET https://deploy:fake-pass-123@registry.example.test/pkg failed';
    assert.equal(maskSecrets(text, {}), 'GET https://deploy:***@registry.example.test/pkg failed');
});

await test('maskSecrets hides auth-token setting values', () => {
    assert.equal(maskSecrets('//registry.npmjs.org/:_authToken=abc123def', {}), '//registry.npmjs.org/:_authToken=***');
    assert.equal(maskSecrets('npmAuthToken: fake-yarn-token', {}), 'npmAuthToken: ***');
    assert.equal(maskSecrets('_auth = ZmFrZTpmYWtl', {}), '_auth = ***');
    assert.equal(maskSecrets('_password="ZmFrZQ=="', {}), '_password=***');
});

await test('maskSecrets hides every occurrence of a secret env value', () => {
    const env = { MY_TOKEN: 'abcdefgh123' };
    assert.equal(maskSecrets('a abcdefgh123 b abcdefgh123', env), 'a *** b ***');
});

await test('maskSecrets replaces longer secret values first', () => {
    const env = { SHORT_SECRET: 'fakesecret', LONG_PASSWORD: 'fakesecret-longer' };
    assert.equal(maskSecrets('x fakesecret-longer y fakesecret', env), 'x *** y ***');
});

await test('maskSecrets keeps short secret values and non-secret variables visible', () => {
    const env = { GITHUB_KEY: 'abc', PATH: '/usr/local/bin:/usr/bin' };
    assert.equal(maskSecrets('abc in /usr/local/bin:/usr/bin', env), 'abc in /usr/local/bin:/usr/bin');
});

await test('maskSecrets matches secret variable names case-insensitively', () => {
    assert.equal(maskSecrets('value fake-api-value', { api_key: 'fake-api-value' }), 'value ***');
});

await test('maskSecrets hides a token used as the URL user without a password', () => {
    assert.equal(maskSecrets('clone https://ghp_abcdefghijk123@github.com/x', {}), 'clone https://***@github.com/x');
    assert.equal(maskSecrets('https://user:secret@host.test/x', {}), 'https://user:***@host.test/x');
});

await test('maskSecrets matches auth-setting names case-insensitively', () => {
    assert.equal(
        maskSecrets('//registry.example.test/:_authtoken=abc123def', {}),
        '//registry.example.test/:_authtoken=***'
    );
});
