import { parseListDocument } from './parser.js';

const BROWSER_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 StuntFlashcards/1.0',
  'Accept': 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
};

const LIST_CACHE_SECONDS = 600;
const IMG_CACHE_SECONDS = 86400;
const MAX_BODY_BYTES = 8_000_000;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === '/api/list') return handleList(request, env, ctx);
    if (url.pathname === '/api/img') return handleImage(request, env, ctx);
    if (url.pathname.startsWith('/api/')) return jsonResponse({ ok: false, error: 'Unknown API endpoint' }, 404);

    return env.ASSETS.fetch(request);
  },
};

function jsonResponse(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      ...extraHeaders,
    },
  });
}

function allowedHostSuffixes(env) {
  return (env.ALLOWED_HOSTS || 'stuntlisting.com')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

function hostAllowed(hostname, suffixes) {
  const h = hostname.toLowerCase();
  return suffixes.some((suffix) => h === suffix || h.endsWith('.' + suffix));
}

function parseTargetUrl(raw) {
  if (!raw) return { error: 'Missing ?url= parameter' };
  let target;
  try {
    target = new URL(raw.trim());
  } catch {
    return { error: 'That does not look like a valid URL' };
  }
  if (target.protocol !== 'https:' && target.protocol !== 'http:') {
    return { error: 'Only http(s) URLs are supported' };
  }
  return { target };
}

// ---------------------------------------------------------------------------
// GET /api/list?url=<list page url>
// ---------------------------------------------------------------------------

async function handleList(request, env, ctx) {
  const reqUrl = new URL(request.url);
  const { target, error } = parseTargetUrl(reqUrl.searchParams.get('url'));
  if (error) return jsonResponse({ ok: false, error }, 400);

  const suffixes = allowedHostSuffixes(env);
  if (!hostAllowed(target.hostname, suffixes)) {
    return jsonResponse(
      {
        ok: false,
        error: `For safety this app only fetches lists from: ${suffixes.join(', ')}. ` +
          'To allow another site, add its domain to ALLOWED_HOSTS in wrangler.jsonc and redeploy.',
      },
      400
    );
  }

  const cache = caches.default;
  const cacheKey = new Request('https://stunt-flashcards.cache/list?u=' + encodeURIComponent(target.toString()));
  const cached = await cache.match(cacheKey);
  if (cached) {
    const res = new Response(cached.body, cached);
    res.headers.set('X-Cache', 'hit');
    return res;
  }

  const attempts = [];
  let result = null;

  // Attempt 1: fetch the page as a browser would.
  const page = await fetchText(target.toString(), { ...BROWSER_HEADERS });
  attempts.push(describeAttempt(target.toString(), page));

  if (page.ok) {
    result = parseListDocument({ body: page.body, contentType: page.contentType, finalUrl: page.finalUrl });
  }

  // Attempt 2: same URL asking for JSON (helps SPA routes that content-negotiate).
  if (!result || result.people.length === 0) {
    const asJson = await fetchText(target.toString(), { ...BROWSER_HEADERS, Accept: 'application/json' });
    attempts.push(describeAttempt(target.toString() + ' (Accept: application/json)', asJson));
    if (asJson.ok && /json/i.test(asJson.contentType || '')) {
      const parsed = parseListDocument({ body: asJson.body, contentType: asJson.contentType, finalUrl: asJson.finalUrl });
      if (parsed.people.length) result = { ...parsed, title: parsed.title || result?.title || '' };
    }
  }

  // Attempt 3: common REST convention — /lists/123 -> /api/lists/123
  if ((!result || result.people.length === 0) && !target.pathname.startsWith('/api/')) {
    const guess = new URL(target.toString());
    guess.pathname = '/api' + guess.pathname;
    const apiTry = await fetchText(guess.toString(), { ...BROWSER_HEADERS, Accept: 'application/json' });
    attempts.push(describeAttempt(guess.toString(), apiTry));
    if (apiTry.ok && /json/i.test(apiTry.contentType || '')) {
      const parsed = parseListDocument({ body: apiTry.body, contentType: apiTry.contentType, finalUrl: apiTry.finalUrl });
      if (parsed.people.length) result = { ...parsed, title: result?.title || parsed.title || '' };
    }
  }

  if (!page.ok && (!result || result.people.length === 0)) {
    return jsonResponse(
      { ok: false, error: `Could not fetch that page (${page.status || page.errorMessage}). Is the URL right and publicly viewable?`, attempts },
      502
    );
  }

  if (!result || result.people.length === 0) {
    const diag = result?.diagnostics || {};
    let hint = 'No people could be found on that page.';
    if (diag.loginPage) hint = 'That page appears to require logging in. Open the list in a private/incognito window to check it is publicly viewable, or use a shareable/public link.';
    else if (diag.clientRendered) hint = 'That page renders entirely in the browser with JavaScript, so the roster is not in the HTML this app can see. If StuntListing offers a share/export or public link for lists, paste that instead.';
    return jsonResponse({ ok: false, error: hint, attempts, diagnostics: diag }, 422);
  }

  const payload = {
    ok: true,
    title: result.title || '',
    sourceUrl: target.toString(),
    fetchedAt: new Date().toISOString(),
    people: result.people,
    diagnostics: { ...result.diagnostics, attempts },
  };
  const res = jsonResponse(payload, 200, { 'Cache-Control': `public, max-age=${LIST_CACHE_SECONDS}` });
  ctx.waitUntil(cache.put(cacheKey, res.clone()));
  return res;
}

function describeAttempt(url, fetched) {
  return { url, status: fetched.status || null, contentType: fetched.contentType || null, error: fetched.errorMessage || null };
}

async function fetchText(url, headers) {
  try {
    const res = await fetch(url, { headers, redirect: 'follow', cf: { cacheTtl: 60 } });
    const buf = await res.arrayBuffer();
    const body = new TextDecoder('utf-8', { fatal: false }).decode(buf.slice(0, MAX_BODY_BYTES));
    return {
      ok: res.ok,
      status: res.status,
      contentType: res.headers.get('content-type') || '',
      finalUrl: res.url || url,
      body,
    };
  } catch (err) {
    return { ok: false, status: 0, errorMessage: String(err && err.message ? err.message : err), body: '', finalUrl: url };
  }
}

// ---------------------------------------------------------------------------
// GET /api/img?src=<image url> — fallback proxy for headshots whose hosts
// block hotlinking. Only ever returns image content.
// ---------------------------------------------------------------------------

async function handleImage(request, env, ctx) {
  const reqUrl = new URL(request.url);
  const { target, error } = parseTargetUrl(reqUrl.searchParams.get('src'));
  if (error) return jsonResponse({ ok: false, error }, 400);

  // Basic SSRF hygiene: no IP literals, no port games, https only.
  if (
    target.protocol !== 'https:' ||
    !target.hostname.includes('.') ||
    /^\d+\.\d+\.\d+\.\d+$/.test(target.hostname) ||
    target.hostname.endsWith('.local') ||
    target.hostname.endsWith('.internal') ||
    (target.port && target.port !== '443')
  ) {
    return jsonResponse({ ok: false, error: 'Image URL not allowed' }, 400);
  }

  const cache = caches.default;
  const cacheKey = new Request('https://stunt-flashcards.cache/img?u=' + encodeURIComponent(target.toString()));
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  let upstream;
  try {
    upstream = await fetch(target.toString(), {
      headers: {
        'User-Agent': BROWSER_HEADERS['User-Agent'],
        'Accept': 'image/avif,image/webp,image/png,image/jpeg,image/*;q=0.8',
        'Referer': target.origin + '/',
      },
      redirect: 'follow',
      cf: { cacheEverything: true, cacheTtl: IMG_CACHE_SECONDS },
    });
  } catch (err) {
    return jsonResponse({ ok: false, error: 'Image fetch failed: ' + String(err.message || err) }, 502);
  }

  const type = upstream.headers.get('content-type') || '';
  const len = Number(upstream.headers.get('content-length') || 0);
  if (!upstream.ok || len > 15_000_000 || (!type.startsWith('image/') && !type.includes('octet-stream'))) {
    return jsonResponse({ ok: false, error: `Upstream did not return an image (status ${upstream.status}, type ${type})` }, 502);
  }

  const res = new Response(upstream.body, {
    status: 200,
    headers: {
      'Content-Type': type.startsWith('image/') ? type : 'image/jpeg',
      'Cache-Control': `public, max-age=${IMG_CACHE_SECONDS}`,
      'Access-Control-Allow-Origin': '*',
    },
  });
  ctx.waitUntil(cache.put(cacheKey, res.clone()));
  return res;
}
