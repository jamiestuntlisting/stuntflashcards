import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  parseListDocument,
  extractJsonBlobs,
  findPeopleInJson,
  stripTags,
  sliceBalancedJson,
  scrapePeopleFromHtml,
} from '../src/parser.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name) => readFileSync(join(here, 'fixtures', name), 'utf8');

const BASE = 'https://stuntlisting.com/lists/42';

test('Next.js-style embedded JSON: full roster with abouts, skills, nested photos', () => {
  const { title, people, diagnostics } = parseListDocument({
    body: fixture('next-data.html'),
    contentType: 'text/html',
    finalUrl: BASE,
  });

  assert.equal(diagnostics.source, 'embedded-json');
  assert.equal(title, 'Action Unit A');
  assert.equal(people.length, 4);

  const jane = people.find((p) => p.name === 'Jane Doe');
  assert.ok(jane, 'Jane Doe found');
  assert.equal(jane.headshot, 'https://stuntlisting.com/uploads/headshots/jane.jpg', 'relative headshot resolved');
  assert.match(jane.about, /Stunt performer & rigger/);
  assert.ok(!jane.about.includes('<p>'), 'about has HTML stripped');
  assert.equal(jane.skills.length, 2);
  assert.equal(jane.skills[0].name, 'Wire Work');
  assert.match(jane.skills[0].description, /80 feet/);

  const marco = people.find((p) => p.name === 'Marco Silva');
  assert.ok(marco, 'first_name/last_name combined');
  assert.equal(marco.headshot, 'https://cdn.example.com/headshots/marco.jpg', 'nested photo.url extracted');
  assert.deepEqual(marco.skills.map((s) => s.name), ['Precision Driving', 'Car Hits']);

  const aiko = people.find((p) => p.name === 'Aiko Tanaka');
  assert.equal(aiko.skills[0].name, 'Martial Arts');
  assert.match(aiko.skills[0].description, /Hong Kong/);

  const noPhoto = people.find((p) => p.name === 'No Photo Person');
  assert.ok(noPhoto, 'photo-less roster member still included');
  assert.equal(noPhoto.headshot, null);

  assert.ok(!people.some((p) => p.name === 'Action Unit A'), 'the list itself is not treated as a person');
});

test('window.__INITIAL_STATE__ assignment blob', () => {
  const { title, people, diagnostics } = parseListDocument({
    body: fixture('state-assign.html'),
    contentType: 'text/html',
    finalUrl: BASE,
  });

  assert.equal(diagnostics.source, 'embedded-json');
  assert.equal(title, 'Crew List | StuntListing');
  assert.equal(people.length, 2);

  const rosa = people.find((p) => p.name === 'Rosa Marquez');
  assert.equal(rosa.headshot, 'https://images.stuntlisting.com/rosa.webp');
  assert.match(rosa.about, /High falls/);
  assert.equal(rosa.skills[0].name, 'Fire Burns');
  assert.match(rosa.skills[0].description, /25 seconds/);

  assert.ok(people.find((p) => p.name === "Lee O'Neil"), 'apostrophe name survives');
});

test('JSON-LD ItemList of Person', () => {
  const { people, diagnostics } = parseListDocument({
    body: fixture('ldjson.html'),
    contentType: 'text/html',
    finalUrl: BASE,
  });

  assert.equal(diagnostics.source, 'embedded-json');
  assert.equal(people.length, 2);
  assert.equal(people[0].name, 'Ivy Chen');
  assert.equal(people[0].headshot, 'https://cdn.example.com/ivy.jpg');
  assert.match(people[0].about, /Parkour/);
});

test('plain HTML card scrape with alt names, data-src, and query strings', () => {
  const { title, people, diagnostics } = parseListDocument({
    body: fixture('plain-cards.html'),
    contentType: 'text/html',
    finalUrl: BASE,
  });

  assert.equal(diagnostics.source, 'html-scrape');
  assert.equal(title, 'My Stunt List');
  assert.equal(people.length, 3, 'logo and icon images are not people');

  const names = people.map((p) => p.name).sort();
  assert.deepEqual(names, ['Nia Kealoha', 'Sam van der Berg', 'Tom Braddock']);
  assert.equal(
    people.find((p) => p.name === 'Tom Braddock').headshot,
    'https://stuntlisting.com/headshots/tom.jpg'
  );
  assert.equal(
    people.find((p) => p.name === 'Sam van der Berg').headshot,
    'https://stuntlisting.com/headshots/sam.jpg',
    'data-src lazy images are picked up'
  );
});

test('client-rendered SPA page reports no people with the right diagnostics', () => {
  const { people, diagnostics } = parseListDocument({
    body: fixture('client-rendered.html'),
    contentType: 'text/html',
    finalUrl: BASE,
  });
  assert.equal(people.length, 0);
  assert.equal(diagnostics.source, 'none');
  assert.equal(diagnostics.clientRendered, true);
});

test('raw JSON API response is parsed directly', () => {
  const body = JSON.stringify({
    data: {
      members: [
        { name: 'Ada Wong', avatar_url: 'https://cdn.example.com/ada.jpg', bio: 'Wire work.' },
        { name: 'Ben Ali', avatar_url: 'https://cdn.example.com/ben.jpg' },
      ],
    },
  });
  const { people, diagnostics } = parseListDocument({ body, contentType: 'application/json', finalUrl: BASE });
  assert.equal(diagnostics.source, 'json-response');
  assert.equal(people.length, 2);
});

test('findPeopleInJson dedupes and merges partial records', () => {
  const data = {
    a: [
      { name: 'Jo Vega', image: 'https://x.example/jo.jpg' },
      { name: 'Kit Marsh', image: 'https://x.example/kit.jpg' },
    ],
    b: { name: 'Jo Vega', image: 'https://x.example/jo.jpg', bio: 'Now with a bio.' },
  };
  const people = findPeopleInJson(data, BASE);
  assert.equal(people.length, 2);
  assert.equal(people.find((p) => p.name === 'Jo Vega').about, 'Now with a bio.');
});

test('sliceBalancedJson respects strings containing braces', () => {
  const text = 'x = {"a":"has } brace","b":[1,2,{"c":"\\" quoted"}]} ; rest';
  const start = text.indexOf('{');
  const slice = sliceBalancedJson(text, start);
  assert.ok(slice);
  const parsed = JSON.parse(slice);
  assert.equal(parsed.a, 'has } brace');
});

test('JSON.parse("...") payloads inside scripts are decoded', () => {
  const html =
    '<script>window.__NUXT_DATA__=null;const s=JSON.parse("{\\"team\\":[{\\"name\\":\\"Pia Cruz\\",\\"photo_url\\":\\"https://c.example/pia.jpg\\"},{\\"name\\":\\"Max Roy\\",\\"photo_url\\":\\"https://c.example/max.jpg\\"}]}");</script>';
  const blobs = extractJsonBlobs(html);
  const people = blobs.flatMap((b) => findPeopleInJson(b, BASE));
  assert.equal(people.length, 2);
  assert.equal(people[0].name, 'Pia Cruz');
});

test('stripTags flattens markup and decodes entities', () => {
  assert.equal(stripTags('<p>Fire &amp; wire</p><p>Falls</p>'), 'Fire & wire\nFalls');
});

test('scrape ignores images with non-name alt text', () => {
  const html = '<img src="/a.jpg" alt="click here now please"><img src="/b.jpg" alt="SALE">';
  assert.equal(scrapePeopleFromHtml(html, BASE).length, 0);
});
