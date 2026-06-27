/**
 * Skeleton shimmer placeholders for loading states
 */

/**
 * Create a DocumentFragment with skeleton card placeholders
 * @param {number} count - Number of skeleton cards to create
 * @returns {DocumentFragment}
 */
export function createSkeletonCards(count = 6) {
  const fragment = document.createDocumentFragment();

  for (let i = 0; i < count; i++) {
    const card = document.createElement('div');
    card.className = 'skeleton-card';

    const poster = document.createElement('div');
    poster.className = 'skeleton-card__poster shimmer';
    card.appendChild(poster);

    const textBlock = document.createElement('div');
    textBlock.className = 'skeleton-card__text';

    const titleLine = document.createElement('div');
    titleLine.className = 'skeleton-card__line skeleton-card__line--title shimmer';
    textBlock.appendChild(titleLine);

    const subtitleLine = document.createElement('div');
    subtitleLine.className = 'skeleton-card__line skeleton-card__line--subtitle shimmer';
    textBlock.appendChild(subtitleLine);

    card.appendChild(textBlock);
    fragment.appendChild(card);
  }

  return fragment;
}

/**
 * Create a skeleton hero banner placeholder
 * @returns {HTMLDivElement}
 */
export function createSkeletonHero() {
  const hero = document.createElement('div');
  hero.className = 'skeleton-hero shimmer';

  const content = document.createElement('div');
  content.className = 'skeleton-hero__content';

  const title = document.createElement('div');
  title.className = 'skeleton-hero__title shimmer';
  content.appendChild(title);

  const meta = document.createElement('div');
  meta.className = 'skeleton-hero__meta shimmer';
  content.appendChild(meta);

  const desc = document.createElement('div');
  desc.className = 'skeleton-hero__desc shimmer';
  content.appendChild(desc);

  const buttons = document.createElement('div');
  buttons.className = 'skeleton-hero__buttons';

  const btn1 = document.createElement('div');
  btn1.className = 'skeleton-hero__button shimmer';
  buttons.appendChild(btn1);

  const btn2 = document.createElement('div');
  btn2.className = 'skeleton-hero__button shimmer';
  buttons.appendChild(btn2);

  content.appendChild(buttons);
  hero.appendChild(content);

  return hero;
}

/**
 * Create skeleton text line placeholders
 * @param {number} lines - Number of text lines
 * @returns {DocumentFragment}
 */
export function createSkeletonText(lines = 3) {
  const fragment = document.createDocumentFragment();

  for (let i = 0; i < lines; i++) {
    const line = document.createElement('div');
    line.className = 'skeleton-text__line shimmer';

    // Last line is shorter for a natural look
    if (i === lines - 1) {
      line.classList.add('skeleton-text__line--short');
    }

    fragment.appendChild(line);
  }

  return fragment;
}
