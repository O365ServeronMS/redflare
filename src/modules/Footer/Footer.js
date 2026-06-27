/**
 * Footer component — site-wide footer with link columns
 */

const COLUMNS = [
  {
    title: 'Thể Loại',
    links: [
      { label: 'Hành Động', href: '/the-loai/hanh-dong' },
      { label: 'Tình Cảm', href: '/the-loai/tinh-cam' },
      { label: 'Hài Hước', href: '/the-loai/hai-huoc' },
      { label: 'Kinh Dị', href: '/the-loai/kinh-di' },
      { label: 'Viễn Tưởng', href: '/the-loai/vien-tuong' },
      { label: 'Tâm Lý', href: '/the-loai/tam-ly' },
    ],
  },
  {
    title: 'Quốc Gia',
    links: [
      { label: 'Việt Nam', href: '/quoc-gia/viet-nam' },
      { label: 'Hàn Quốc', href: '/quoc-gia/han-quoc' },
      { label: 'Trung Quốc', href: '/quoc-gia/trung-quoc' },
      { label: 'Âu Mỹ', href: '/quoc-gia/au-my' },
      { label: 'Nhật Bản', href: '/quoc-gia/nhat-ban' },
      { label: 'Thái Lan', href: '/quoc-gia/thai-lan' },
    ],
  },
  {
    title: 'Danh Mục',
    links: [
      { label: 'Phim Lẻ', href: '/danh-sach/phim-le' },
      { label: 'Phim Bộ', href: '/danh-sach/phim-bo' },
      { label: 'Hoạt Hình', href: '/danh-sach/hoat-hinh' },
      { label: 'TV Shows', href: '/danh-sach/tv-shows' },
    ],
  },
  {
    title: 'Thông Tin',
    items: [
      { type: 'text', content: 'Film Bluesia' },
      { type: 'text', content: 'Xem phim trực tuyến miễn phí' },
      { type: 'text', content: 'Liên hệ: contact@filmbluesia.com' },
    ],
  },
];

/**
 * Render the site footer.
 * @param {HTMLElement} container
 */
export function renderFooter(container) {
  const footer = document.createElement('footer');
  footer.className = 'footer';

  // ── Top section with columns ──
  const columnsWrapper = document.createElement('div');
  columnsWrapper.className = 'footer__grid';

  COLUMNS.forEach((col) => {
    const column = document.createElement('div');
    column.className = 'footer__column';

    const title = document.createElement('h3');
    title.className = 'footer__column-title';
    title.textContent = col.title;
    column.appendChild(title);

    if (col.links) {
      const list = document.createElement('ul');
      list.className = 'footer__link-list';

      col.links.forEach(({ label, href }) => {
        const li = document.createElement('li');
        const a = document.createElement('a');
        a.className = 'footer__link';
        a.href = href;
        a.textContent = label;
        li.appendChild(a);
        list.appendChild(li);
      });

      column.appendChild(list);
    }

    if (col.items) {
      const list = document.createElement('ul');
      list.className = 'footer__info-list';

      col.items.forEach(({ content }) => {
        const li = document.createElement('li');
        li.className = 'footer__info-item';
        li.textContent = content;
        list.appendChild(li);
      });

      column.appendChild(list);
    }

    columnsWrapper.appendChild(column);
  });

  footer.appendChild(columnsWrapper);

  // ── Bottom bar ──
  const bottomBar = document.createElement('div');
  bottomBar.className = 'footer__bottom';

  const copyright = document.createElement('p');
  copyright.className = 'footer__copyright';
  copyright.textContent = '© 2024 Film Bluesia. All rights reserved.';
  bottomBar.appendChild(copyright);

  footer.appendChild(bottomBar);

  container.appendChild(footer);
}
