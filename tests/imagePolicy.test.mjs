import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DESKTOP_IMAGE_MEDIA,
  RESPONSIVE_IMAGE_VARIANTS,
  createResponsivePicture,
  getResponsiveTmdbSources,
  toTmdbImageSize,
} from '../src/lib/image.js';

const tmdbPoster = 'https://image.tmdb.org/t/p/w500/poster.jpg';
const tmdbBackdrop = 'https://image.tmdb.org/t/p/w1280/backdrop.jpg';
const kkphimImage = 'https://phimimg.com/uploads/poster.jpg';

test('changes only TMDB poster variants', () => {
  assert.equal(toTmdbImageSize(tmdbPoster, 'w154'), 'https://image.tmdb.org/t/p/w154/poster.jpg');
  assert.equal(toTmdbImageSize(tmdbBackdrop, 'w185'), tmdbBackdrop);
  assert.equal(toTmdbImageSize(kkphimImage, 'w500'), kkphimImage);
});


test('defines mobile and desktop sources for the two planned responsive surfaces', () => {
  assert.deepEqual(
    getResponsiveTmdbSources(tmdbPoster, RESPONSIVE_IMAGE_VARIANTS.heroRail),
    {
      mobileSrc: 'https://image.tmdb.org/t/p/w154/poster.jpg',
      desktopSrc: 'https://image.tmdb.org/t/p/w185/poster.jpg',
      desktopMedia: DESKTOP_IMAGE_MEDIA,
    }
  );

  assert.deepEqual(
    getResponsiveTmdbSources(tmdbPoster, RESPONSIVE_IMAGE_VARIANTS.posterCard),
    {
      mobileSrc: 'https://image.tmdb.org/t/p/w185/poster.jpg',
      desktopSrc: 'https://image.tmdb.org/t/p/w500/poster.jpg',
      desktopMedia: DESKTOP_IMAGE_MEDIA,
    }
  );
});

test('keeps non-TMDB images identical at both breakpoints', () => {
  assert.deepEqual(
    getResponsiveTmdbSources(kkphimImage, RESPONSIVE_IMAGE_VARIANTS.posterCard),
    {
      mobileSrc: kkphimImage,
      desktopSrc: kkphimImage,
      desktopMedia: DESKTOP_IMAGE_MEDIA,
    }
  );
});

test('renders a desktop source only when the two variants differ', () => {
  const originalDocument = globalThis.document;
  globalThis.document = {
    createElement(tagName) {
      return {
        tagName,
        children: [],
        appendChild(child) {
          this.children.push(child);
        },
      };
    },
  };

  try {
    const sources = getResponsiveTmdbSources(tmdbPoster, RESPONSIVE_IMAGE_VARIANTS.posterCard);
    const img = { tagName: 'img' };
    const picture = createResponsivePicture(img, sources);

    assert.equal(picture.tagName, 'picture');
    assert.equal(picture.children.length, 2);
    assert.equal(picture.children[0].tagName, 'source');
    assert.equal(picture.children[0].media, DESKTOP_IMAGE_MEDIA);
    assert.equal(picture.children[0].srcset, 'https://image.tmdb.org/t/p/w500/poster.jpg');
    assert.equal(picture.children[1], img);

    const plainImg = { tagName: 'img' };
    const plainSources = getResponsiveTmdbSources(kkphimImage, RESPONSIVE_IMAGE_VARIANTS.posterCard);
    const plainPicture = createResponsivePicture(plainImg, plainSources);
    assert.deepEqual(plainPicture.children, [plainImg]);
  } finally {
    if (originalDocument === undefined) delete globalThis.document;
    else globalThis.document = originalDocument;
  }
});
