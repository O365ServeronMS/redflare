/**
 * Recommendation — "Bạn cũng có thể thích" related-titles block.
 *
 * Module map (one name across every layer — see MODULES.md):
 *   UI            src/modules/Recommendation/Recommendation.js   (this file)
 *   API client    getRecommendation()  in src/api/ophim.js
 *   Backend       GET /api/recommendation/:type/:id  (catalog-api recommendation.js)
 *   Cache         catalog:c1:related:* + idx:* (Valkey, on the VPS)
 *
 * Fire-and-forget: resolves TMDB recommendations (via the VPS catalog-api) for the
 * current title and renders them as a carousel. Must NOT block the detail render.
 * Currently reuses the Carousel module's styling — no dedicated CSS yet.
 */

import { getRecommendation } from '../../api/ophim.js';
import { renderCarousel } from '../Carousel/Carousel.js';

const TITLE = 'Bạn cũng có thể thích';
const SKELETON_CARD_COUNT = 5;

function renderLoading(container) {
  const section = document.createElement('section');
  section.className = 'recommendation recommendation--loading';
  section.setAttribute('aria-busy', 'true');

  const header = document.createElement('div');
  header.className = 'carousel__header';
  const heading = document.createElement('h2');
  heading.className = 'carousel__title';
  heading.textContent = TITLE;
  header.appendChild(heading);
  section.appendChild(header);

  const track = document.createElement('div');
  track.className = 'recommendation__skeleton-track';
  track.setAttribute('aria-hidden', 'true');
  for (let index = 0; index < SKELETON_CARD_COUNT; index += 1) {
    const card = document.createElement('div');
    card.className = 'recommendation__skeleton-card skeleton-shimmer';
    track.appendChild(card);
  }
  section.appendChild(track);
  container.replaceChildren(section);
}

function renderError(container, retry) {
  const section = document.createElement('section');
  section.className = 'recommendation recommendation--error';

  const message = document.createElement('p');
  message.className = 'recommendation__error-message';
  message.setAttribute('role', 'status');
  message.textContent = 'Không tải được gợi ý';
  section.appendChild(message);

  const button = document.createElement('button');
  button.className = 'recommendation__retry';
  button.type = 'button';
  button.textContent = 'Thử lại';
  button.addEventListener('click', retry, { once: true });
  section.appendChild(button);
  container.replaceChildren(section);
}

export async function renderRecommendation(container, movie) {
  const tmdbId = movie.tmdb?.id;
  if (!tmdbId) {
    container.replaceChildren();
    return;
  }

  const load = async () => {
    renderLoading(container);
    try {
      const items = await getRecommendation(tmdbId, movie.tmdb?.type);
      if (!items.length) {
        container.replaceChildren();
        return;
      }
      container.replaceChildren();
      renderCarousel(container, { title: TITLE, items });
    } catch {
      renderError(container, load);
    }
  };

  await load();
}
