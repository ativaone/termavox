// Termdock site: small progressive enhancements. Every page works without this file.

// The index lights the section being read.
const links = new Map();
for (const link of document.querySelectorAll('.index-list a[href^="#"]')) {
  const id = decodeURIComponent(link.getAttribute('href').slice(1));
  if (!links.has(id)) links.set(id, []);
  links.get(id).push(link);
}
const targets = [...links.keys()].map((id) => document.getElementById(id)).filter(Boolean);
if (targets.length > 0 && 'IntersectionObserver' in window) {
  const visible = new Set();
  const light = () => {
    const current = targets.find((el) => visible.has(el)) ?? null;
    for (const [id, items] of links) {
      for (const link of items) {
        if (current && current.id === id) link.setAttribute('aria-current', 'true');
        else link.removeAttribute('aria-current');
      }
    }
  };
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) visible.add(entry.target);
        else visible.delete(entry.target);
      }
      light();
    },
    { rootMargin: '-72px 0px -55% 0px' },
  );
  for (const target of targets) observer.observe(target);
}

// The other language opens at the same section (both languages share their anchors).
for (const link of document.querySelectorAll('a[data-keep-hash]')) {
  link.addEventListener('click', () => {
    if (location.hash) link.href = link.href.split('#')[0] + location.hash;
  });
}

// Code blocks get a copy button.
const words =
  document.documentElement.lang === 'pt-BR'
    ? { copy: 'Copiar', copied: 'Copiado' }
    : { copy: 'Copy', copied: 'Copied' };
for (const block of document.querySelectorAll('pre.code')) {
  if (!navigator.clipboard) break;
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'copy';
  button.textContent = words.copy;
  button.addEventListener('click', () => {
    navigator.clipboard.writeText(block.querySelector('code')?.textContent ?? '').then(
      () => {
        button.textContent = words.copied;
        setTimeout(() => {
          button.textContent = words.copy;
        }, 1600);
      },
      () => {},
    );
  });
  // Outside the scrolling block, so the button stays put when long lines scroll sideways.
  const wrap = document.createElement('div');
  wrap.className = 'code-wrap';
  block.replaceWith(wrap);
  wrap.append(block, button);
}
