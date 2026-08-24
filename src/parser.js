// Parses a stunt-listing "list" page into a roster of people:
//   { name, headshot, about, skills: [{ name, description }] }
//
// Strategy, in order of reliability:
//   1. Embedded JSON blobs (__NEXT_DATA__, __NUXT__, __INITIAL_STATE__,
//      <script type="application/json">, JSON-LD) — deep-scanned for
//      person-shaped objects.
//   2. HTML scraping — profile-card <a> blocks and <img alt="First Last"> tags.
//
// Pure string/JSON logic only (no DOM, no fetch) so it runs unchanged in the
// Worker and under `node --test`.

const NAME_KEYS = [
  'name', 'full_name', 'fullName', 'fullname', 'display_name', 'displayName',
  'stage_name', 'stageName', 'performer_name', 'performerName', 'legal_name', 'legalName',
];
const FIRST_KEYS = ['first_name', 'firstName', 'given_name', 'givenName'];
const LAST_KEYS = ['last_name', 'lastName', 'family_name', 'familyName', 'surname'];
const IMAGE_KEYS = [
  'headshot', 'headshot_url', 'headshotUrl', 'headshot_image', 'headshotImage',
  'photo', 'photo_url', 'photoUrl', 'profile_photo', 'profilePhoto',
  'profile_image', 'profileImage', 'profile_picture', 'profilePicture',
  'image', 'image_url', 'imageUrl', 'avatar', 'avatar_url', 'avatarUrl',
  'picture', 'thumbnail', 'thumbnail_url', 'thumbnailUrl', 'thumb', 'img', 'src', 'photoURL',
];
const NESTED_URL_KEYS = ['url', 'src', 'secure_url', 'secureUrl', 'original', 'large', 'medium', 'full', 'href'];
const ABOUT_KEYS = [
  'about', 'about_me', 'aboutMe', 'bio', 'biography', 'description', 'summary',
  'blurb', 'profile_text', 'profileText', 'intro', 'overview',
];
const SKILLS_KEYS = ['skills', 'skill_list', 'skillList', 'specialties', 'specialities', 'abilities', 'talents'];
const SKILL_NAME_KEYS = ['name', 'title', 'skill', 'skill_name', 'skillName', 'label'];
const SKILL_DESC_KEYS = ['description', 'desc', 'details', 'detail', 'notes', 'note', 'text', 'summary', 'experience'];

const MAX_SCAN_NODES = 80000;
const MAX_DEPTH = 24;

// ---------------------------------------------------------------------------
// Small HTML helpers
// ---------------------------------------------------------------------------

export function decodeEntities(s) {
  if (!s) return s;
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => safeFromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => safeFromCodePoint(parseInt(d, 10)))
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'");
}

function safeFromCodePoint(n) {
  try {
    return String.fromCodePoint(n);
  } catch {
    return '';
  }
}

export function stripTags(html) {
  if (!html) return '';
  return decodeEntities(
    String(html)
      .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|li|h[1-6])>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
  )
    .replace(/[ \t\r\f\v]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim();
}

function resolveUrl(u, baseUrl) {
  if (!u) return null;
  try {
    return new URL(u, baseUrl).toString();
  } catch {
    return null;
  }
}

function looksLikeUrlish(s) {
  if (typeof s !== 'string') return false;
  const t = s.trim();
  if (!t || t.length > 2048 || /\s/.test(t)) return false;
  return /^https?:\/\//i.test(t) || t.startsWith('//') || t.startsWith('/') || /^data:image\//i.test(t);
}

// ---------------------------------------------------------------------------
// Person extraction from arbitrary JSON
// ---------------------------------------------------------------------------

function pickString(obj, keys) {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return null;
}

function pickImage(obj) {
  for (const k of IMAGE_KEYS) {
    const v = obj[k];
    if (typeof v === 'string' && looksLikeUrlish(v)) return v.trim();
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      for (const nk of NESTED_URL_KEYS) {
        const nv = v[nk];
        if (typeof nv === 'string' && looksLikeUrlish(nv)) return nv.trim();
      }
    }
  }
  return null;
}

export function looksLikePersonName(s) {
  if (typeof s !== 'string') return false;
  const t = s.trim();
  if (t.length < 2 || t.length > 80) return false;
  if (/https?:\/\//i.test(t) || t.includes('@')) return false;
  const words = t.split(/\s+/);
  if (words.length > 6) return false;
  if (!/\p{L}/u.test(t)) return false;
  return true;
}

function normalizeSkills(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const item of raw.slice(0, 60)) {
    if (typeof item === 'string' && item.trim()) {
      out.push({ name: stripTags(item).slice(0, 120), description: '' });
    } else if (item && typeof item === 'object' && !Array.isArray(item)) {
      const name = pickString(item, SKILL_NAME_KEYS);
      if (!name) continue;
      const desc = pickString(item, SKILL_DESC_KEYS) || '';
      out.push({
        name: stripTags(name).slice(0, 120),
        description: stripTags(desc).slice(0, 1200),
      });
    }
  }
  return out;
}

function extractPerson(obj, baseUrl) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;

  let name = pickString(obj, NAME_KEYS);
  if (!name) {
    const first = pickString(obj, FIRST_KEYS);
    const last = pickString(obj, LAST_KEYS);
    if (first) name = [first, last].filter(Boolean).join(' ');
  }
  if (!name || !looksLikePersonName(name)) return null;

  const image = pickImage(obj);
  const aboutRaw = pickString(obj, ABOUT_KEYS);
  let skills = [];
  for (const k of SKILLS_KEYS) {
    if (Array.isArray(obj[k])) {
      skills = normalizeSkills(obj[k]);
      if (skills.length) break;
    }
  }

  return {
    name: stripTags(name).slice(0, 120),
    headshot: image ? resolveUrl(image, baseUrl) : null,
    about: aboutRaw ? stripTags(aboutRaw).slice(0, 4000) : '',
    skills,
  };
}

function personKey(p) {
  return p.name.toLowerCase().replace(/\s+/g, ' ').trim();
}

function mergePerson(existing, extra) {
  if (!existing.headshot && extra.headshot) existing.headshot = extra.headshot;
  if ((!existing.about || existing.about.length < extra.about.length) && extra.about) existing.about = extra.about;
  if (extra.skills.length > existing.skills.length) existing.skills = extra.skills;
}

// Walk arbitrary JSON. Arrays where >= 2 elements look like people-with-photos
// are treated as rosters: their photo-less members are accepted too.
export function findPeopleInJson(root, baseUrl) {
  const byKey = new Map();
  let scanned = 0;

  const add = (p) => {
    if (!p) return;
    const key = personKey(p);
    if (byKey.has(key)) mergePerson(byKey.get(key), p);
    else byKey.set(key, p);
  };

  const walk = (node, depth) => {
    if (scanned++ > MAX_SCAN_NODES || depth > MAX_DEPTH || node == null) return;

    if (Array.isArray(node)) {
      const candidates = node.map((el) => extractPerson(el, baseUrl));
      const withPhoto = candidates.filter((p) => p && p.headshot);
      if (withPhoto.length >= 2) {
        for (const p of candidates) if (p) add(p);
      }
      for (const el of node) walk(el, depth + 1);
      return;
    }

    if (typeof node === 'object') {
      const p = extractPerson(node, baseUrl);
      if (p && p.headshot) add(p);
      for (const v of Object.values(node)) walk(v, depth + 1);
    }
  };

  walk(root, 0);
  return [...byKey.values()];
}

// ---------------------------------------------------------------------------
// Embedded JSON discovery
// ---------------------------------------------------------------------------

// Balanced-brace scan that respects strings/escapes, so blobs like
// `window.__STATE__ = {...};` can be sliced out of inline scripts.
export function sliceBalancedJson(text, startIdx) {
  const open = text[startIdx];
  if (open !== '{' && open !== '[') return null;
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inStr = false;
  let esc = false;
  const max = Math.min(text.length, startIdx + 8_000_000);
  for (let i = startIdx; i < max; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') {
      depth--;
      if (depth === 0) {
        if (c !== close) return null;
        return text.slice(startIdx, i + 1);
      }
    }
  }
  return null;
}

export function extractJsonBlobs(html) {
  const blobs = [];

  // <script type="application/json"> and <script type="application/ld+json">
  const scriptRe = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = scriptRe.exec(html))) {
    const attrs = m[1] || '';
    const body = (m[2] || '').trim();
    if (!body) continue;
    if (/type\s*=\s*["']application\/(ld\+)?json["']/i.test(attrs)) {
      try {
        blobs.push(JSON.parse(body));
      } catch {
        /* ignore malformed blob */
      }
    } else {
      // Inline app-state assignments: window.__NUXT__ = {...};  __INITIAL_STATE__ = {...}
      const assignRe = /(?:window\.|self\.|globalThis\.)?__[A-Z][A-Z0-9_]*__(?:\.[$\w]+)?\s*=\s*/g;
      let a;
      while ((a = assignRe.exec(body))) {
        const start = a.index + a[0].length;
        const ch = body[start];
        if (ch !== '{' && ch !== '[') continue;
        const slice = sliceBalancedJson(body, start);
        if (!slice) continue;
        try {
          blobs.push(JSON.parse(slice));
        } catch {
          /* JS literal, not strict JSON — skip */
        }
      }
      // JSON.parse("…") payloads (Nuxt 3 / SvelteKit style)
      const jpRe = /JSON\.parse\(\s*(["'])/g;
      let j;
      while ((j = jpRe.exec(body))) {
        const strStart = j.index + j[0].length - 1;
        const raw = sliceJsString(body, strStart, j[1]);
        if (!raw) continue;
        try {
          blobs.push(JSON.parse(JSON.parse(raw.replaceAll("\\'", "'").replace(/^'|'$/g, '"'))));
        } catch {
          try {
            blobs.push(JSON.parse(evalStringLiteral(raw)));
          } catch {
            /* ignore */
          }
        }
      }
    }
  }
  return blobs;
}

function sliceJsString(text, startIdx, quote) {
  let esc = false;
  for (let i = startIdx + 1; i < Math.min(text.length, startIdx + 8_000_000); i++) {
    const c = text[i];
    if (esc) {
      esc = false;
      continue;
    }
    if (c === '\\') esc = true;
    else if (c === quote) return text.slice(startIdx, i + 1);
  }
  return null;
}

// Decode a quoted JS string literal (single or double quoted) to its value.
function evalStringLiteral(raw) {
  const quote = raw[0];
  const body = raw.slice(1, -1);
  if (quote === '"') return JSON.parse(raw);
  // single-quoted: escape double quotes, unescape single quotes, reuse JSON.parse
  return JSON.parse('"' + body.replace(/\\'/g, "'").replace(/"/g, '\\"') + '"');
}

// ---------------------------------------------------------------------------
// HTML fallback scraping
// ---------------------------------------------------------------------------

const NON_PERSON_IMG = /logo|icon|sprite|placeholder|banner|badge|button|arrow|star|flag|emoji|favicon/i;

function altLooksLikeName(alt) {
  if (!alt) return false;
  const t = decodeEntities(alt).replace(/\b(headshot|photo|picture|image|portrait|profile)( of)?\b/gi, '').replace(/\s+/g, ' ').trim();
  if (!t || t.length < 4 || t.length > 60) return false;
  const words = t.split(' ');
  if (words.length < 2 || words.length > 5) return false;
  if (!words.every((w) => /^[\p{Lu}][\p{L}'’.-]*$|^(de|del|della|der|den|da|di|du|la|le|los|las|van|von|ter|ten|te|bin|ibn|al|el|y|e)$/u.test(w))) return false;
  return t;
}

export function scrapePeopleFromHtml(html, baseUrl) {
  const byKey = new Map();
  const add = (p) => {
    const key = personKey(p);
    if (byKey.has(key)) mergePerson(byKey.get(key), p);
    else byKey.set(key, p);
  };

  // Pass 1: <img> tags whose alt text is a person name.
  const imgRe = /<img\b[^>]*>/gi;
  let m;
  while ((m = imgRe.exec(html))) {
    const tag = m[0];
    const src = attrValue(tag, 'src') || attrValue(tag, 'data-src') || srcsetFirst(attrValue(tag, 'srcset'));
    if (!src || NON_PERSON_IMG.test(src)) continue;
    const name = altLooksLikeName(attrValue(tag, 'alt'));
    if (!name) continue;
    add({ name, headshot: resolveUrl(src, baseUrl), about: '', skills: [] });
  }

  // Pass 2: anchor "cards" that link to a profile page and contain an image.
  if (byKey.size < 2) {
    const cardRe = /<a\b[^>]*href\s*=\s*["']([^"']*(?:profile|performer|talent|stunt|people|member|user)[^"']*)["'][^>]*>([\s\S]{0,4000}?)<\/a>/gi;
    while ((m = cardRe.exec(html))) {
      const inner = m[2];
      const imgTag = inner.match(/<img\b[^>]*>/i);
      const src = imgTag ? attrValue(imgTag[0], 'src') || attrValue(imgTag[0], 'data-src') || srcsetFirst(attrValue(imgTag[0], 'srcset')) : null;
      const text = stripTags(inner);
      const firstLine = text.split('\n').map((s) => s.trim()).find((s) => s.length >= 4 && s.length <= 60 && looksLikePersonName(s));
      if (!firstLine || !src || NON_PERSON_IMG.test(src)) continue;
      add({ name: firstLine, headshot: resolveUrl(src, baseUrl), about: '', skills: [] });
    }
  }

  return [...byKey.values()];
}

function attrValue(tag, attr) {
  const re = new RegExp(`\\b${attr}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i');
  const m = tag.match(re);
  if (!m) return null;
  return decodeEntities(m[2] ?? m[3] ?? m[4] ?? '').trim() || null;
}

function srcsetFirst(srcset) {
  if (!srcset) return null;
  const first = srcset.split(',')[0]?.trim().split(/\s+/)[0];
  return first || null;
}

// ---------------------------------------------------------------------------
// Page title
// ---------------------------------------------------------------------------

export function extractTitle(html) {
  const og = html.match(/<meta\b[^>]*property\s*=\s*["']og:title["'][^>]*>/i);
  if (og) {
    const v = attrValue(og[0], 'content');
    if (v) return v.slice(0, 200);
  }
  const h1 = html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i);
  if (h1) {
    const t = stripTags(h1[1]);
    if (t) return t.slice(0, 200);
  }
  const title = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
  if (title) {
    const t = stripTags(title[1]);
    if (t) return t.slice(0, 200);
  }
  return '';
}

export function looksClientRendered(html) {
  const noJsBody = stripTags(html);
  return noJsBody.length < 400 && /<div[^>]*id\s*=\s*["'](root|app|__next|___gatsby)["']/i.test(html);
}

export function looksLikeLoginPage(html, finalUrl) {
  if (/\/(log-?in|sign-?in|auth)\b/i.test(finalUrl || '')) return true;
  return /<input[^>]*type\s*=\s*["']password["']/i.test(html) && !/<img[^>]*(headshot|avatar|profile)/i.test(html);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function parseListDocument({ body, contentType, finalUrl }) {
  const diagnostics = { source: null, jsonBlobs: 0, clientRendered: false, loginPage: false };

  // Raw JSON response (API endpoint pasted directly, or Accept: application/json honored)
  if (/json/i.test(contentType || '') || /^\s*[[{]/.test(body.slice(0, 64))) {
    try {
      const data = JSON.parse(body);
      const people = findPeopleInJson(data, finalUrl);
      diagnostics.source = 'json-response';
      return { title: '', people, diagnostics };
    } catch {
      /* fall through to HTML handling */
    }
  }

  const html = body;
  const title = extractTitle(html);
  diagnostics.clientRendered = looksClientRendered(html);
  diagnostics.loginPage = looksLikeLoginPage(html, finalUrl);

  const blobs = extractJsonBlobs(html);
  diagnostics.jsonBlobs = blobs.length;

  let best = [];
  for (const blob of blobs) {
    const people = findPeopleInJson(blob, finalUrl);
    if (people.length > best.length) best = people;
  }
  if (best.length >= 1) {
    diagnostics.source = 'embedded-json';
    return { title, people: best, diagnostics };
  }

  const scraped = scrapePeopleFromHtml(html, finalUrl);
  if (scraped.length) {
    diagnostics.source = 'html-scrape';
    return { title, people: scraped, diagnostics };
  }

  diagnostics.source = 'none';
  return { title, people: [], diagnostics };
}

// ---------------------------------------------------------------------------
// API endpoint guessing
// ---------------------------------------------------------------------------

// When a page turns out to be client-rendered, its roster came from an API.
// These are the conventional places that API tends to live, in rough order of
// likelihood. Query strings are preserved so filters (location, height, …)
// carry over to the API call.
export function apiCandidateUrls(rawUrl) {
  let u;
  try {
    u = new URL(rawUrl);
  } catch {
    return [];
  }
  const q = u.search || '';
  const path = u.pathname.replace(/\/+$/, '') || '/';
  const self = u.toString();
  const out = [];
  const add = (p) => {
    const full = u.origin + p;
    if (full !== self && !out.includes(full)) out.push(full);
  };

  if (!path.startsWith('/api/')) add('/api' + path + q);
  add('/api/lists' + q);
  add('/api/list' + q);
  add('/api/v1/lists' + q);
  add('/api/performers' + q);
  add('/api/v1/performers' + q);
  add('/api/talent' + q);
  add('/api/search' + q);
  if (path !== '/') add(path + '.json' + q);

  return out.slice(0, 9);
}

// ---------------------------------------------------------------------------
// GraphQL operation extraction
// ---------------------------------------------------------------------------

// Match a balanced {...} run starting at startIdx. GraphQL documents rarely
// contain braces inside strings, so plain counting is enough — but bail out
// rather than scan forever on minified junk.
export function sliceBalancedBraces(text, startIdx, maxLen = 8000) {
  if (text[startIdx] !== '{') return null;
  let depth = 0;
  const end = Math.min(text.length, startIdx + maxLen);
  for (let i = startIdx; i < end; i++) {
    const c = text[i];
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return text.slice(startIdx, i + 1);
    }
  }
  return null;
}

const INTERESTING_OP = /list|performer|user|profile|search|roster|member|talent|skill/i;

// Pull GraphQL operation definitions out of a bundle. Returns operation
// signatures ("query GetList") plus the full text of the ones that look
// roster-related, so the real query can be copied rather than guessed.
export function extractGraphqlOperations(text, acc = { names: new Set(), documents: [] }) {
  if (!text) return acc;
  const re = /\b(query|mutation)\s+([A-Za-z_]\w*)\s*(\([^)]{0,600}\))?\s*\{/g;
  let m;
  while ((m = re.exec(text))) {
    if (acc.names.size > 300) break;
    const [full, kind, name] = m;
    acc.names.add(`${kind} ${name}${m[3] || ''}`.slice(0, 300));
    const braceIdx = m.index + full.length - 1;
    if (acc.documents.length >= 10) continue;
    const body = sliceBalancedBraces(text, braceIdx);
    if (!body) continue;
    const doc = text.slice(m.index, braceIdx) + body;
    if (INTERESTING_OP.test(name) || INTERESTING_OP.test(body.slice(0, 400))) {
      acc.documents.push(doc.slice(0, 4000));
    }
  }
  return acc;
}
