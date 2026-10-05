import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseBrowser } from '../login.ts';

test('navigateur : --browser, sinon DOCS_BROWSER, sinon Firefox', () => {
  const saved = process.env.DOCS_BROWSER;
  try {
    delete process.env.DOCS_BROWSER;
    assert.equal(parseBrowser(), 'firefox');
    process.env.DOCS_BROWSER = 'Chromium';
    assert.equal(parseBrowser(), 'chromium');
    assert.equal(parseBrowser('firefox'), 'firefox');
    assert.throws(() => parseBrowser('safari'), /Navigateur inconnu : safari/);
  } finally {
    if (saved === undefined) delete process.env.DOCS_BROWSER;
    else process.env.DOCS_BROWSER = saved;
  }
});
