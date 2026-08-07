import { Hono } from 'hono';
import type { Env } from '../types/env';
import { SearchRepository } from '../repositories/searchRepository';
import { renderSearchPage } from '../render/searchPage';
import { applyPageCache, apply404Cache } from '../cache/control';
import { canonicalRedirectPath } from '../lib/canonicalQuery';

export const searchRoute = new Hono<{ Bindings: Env }>();
const RESULT_LIMIT = 24;
const MAX_QUERY_LENGTH = 100; // ADR-0002 "Security": reject, don't sanitize

searchRoute.get('/tim-kiem', async (c) => {
  const url = new URL(c.req.url);
  const redirect = canonicalRedirectPath('/tim-kiem', url.searchParams, ['q']);
  if (redirect) return c.redirect(redirect, 301);

  const q = (url.searchParams.get('q') ?? '').trim();
  if (!q || q.length > MAX_QUERY_LENGTH) {
    apply404Cache(c);
    return c.text('Not found', 404);
  }

  const results = await new SearchRepository(c.env.DB).search(q, RESULT_LIMIT);

  // Cache-Tag is deliberately generic ("tier:search"), not per-query --
  // query cardinality is unbounded, so tagging per-query would recreate
  // exactly the problem canonicalRedirectPath exists to prevent elsewhere.
  applyPageCache(c, ['tier:search']);
  return c.html(renderSearchPage(q, results));
});
