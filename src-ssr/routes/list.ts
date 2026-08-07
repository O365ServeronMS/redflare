import { Hono } from 'hono';
import type { Env } from '../types/env';
import { MovieRepository } from '../repositories/movieRepository';
import { renderListPage } from '../render/listPage';
import { SITE_ORIGIN } from '../render/seo';
import { decodeCursor } from '../lib/cursor';
import { LIST_TYPE_LABELS } from '../lib/listTypes';
import { applyPageCache, apply404Cache } from '../cache/control';
import { canonicalRedirectPath } from '../lib/canonicalQuery';

export const listRoute = new Hono<{ Bindings: Env }>();
const PAGE_SIZE = 24;

listRoute.get('/danh-sach/:type', async (c) => {
  const typeSlug = c.req.param('type');
  const entry = LIST_TYPE_LABELS[typeSlug];
  if (!entry) {
    apply404Cache(c);
    return c.text('Not found', 404);
  }

  const url = new URL(c.req.url);
  const redirect = canonicalRedirectPath(`/danh-sach/${typeSlug}`, url.searchParams, ['cursor']);
  if (redirect) return c.redirect(redirect, 301);

  const cursor = decodeCursor(url.searchParams.get('cursor') ?? undefined);
  const { items, nextCursor } = await new MovieRepository(c.env.DB).getPageByType(entry.value, cursor, PAGE_SIZE);

  applyPageCache(c, [`type:${typeSlug}`, 'tier:list']);
  return c.html(
    renderListPage({
      h1: entry.label,
      description: `Danh sách ${entry.label} mới cập nhật trên Film Bluesia.`,
      canonicalPath: `/danh-sach/${typeSlug}`,
      breadcrumb: [
        { name: 'Trang chủ', url: SITE_ORIGIN },
        { name: entry.label, url: `${SITE_ORIGIN}/danh-sach/${typeSlug}` },
      ],
      items,
      nextCursor,
    })
  );
});
