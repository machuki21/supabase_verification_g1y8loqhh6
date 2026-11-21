import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeEntities, parseListedRetail, conditionFlags, searchQuery } from '../src/text.js';

test('decodes BidRL HTML entities', () => {
  assert.equal(decodeEntities('Sinus PE &#38; Allergy'), 'Sinus PE & Allergy');
  assert.equal(decodeEntities('Women&#39;s &quot;Rochelle&quot; &amp; more'), `Women's "Rochelle" & more`);
  assert.equal(decodeEntities('&#x2122; &bogus;'), '™ &bogus;');
});

test('parses listed retail price', () => {
  assert.equal(parseListedRetail('GRAT Heat Pump, Factory Sealed, Retail $2,199'), 2199);
  assert.equal(parseListedRetail('Coffee Machine, Retail $120'), 120);
  assert.equal(parseListedRetail('Lamp MSRP: $49.99'), 49.99);
  assert.equal(parseListedRetail('Value Pack of Equate 300 Count'), null);
  assert.equal(parseListedRetail('no price', 'Retail price $35 per box'), 35);
  assert.equal(parseListedRetail('Retail $0'), null);
});

test('flags condition risks and sealed items', () => {
  assert.deepEqual(conditionFlags('Shark Mop, Factory Sealed, Retail $120'), ['sealed']);
  assert.deepEqual(conditionFlags('Drill', 'Untested, missing battery'), ['untested', 'missing parts']);
  assert.deepEqual(conditionFlags('Equate Aspirin 81 mg'), []);
});

test('builds a clean Amazon search query', () => {
  assert.equal(searchQuery('Brother HC1850 Sewing and Quilting Machine, Factory Sealed, Retail $300'), 'Brother HC1850 Sewing and Quilting Machine');
  assert.equal(searchQuery('Sinus PE &#38; Allergy (24 count)'), 'Sinus PE & Allergy (24 count)');
});
