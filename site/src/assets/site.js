// Termdock site: small progressive enhancements. Every page works without this file.

// The index lights the section being read.
const links = new Map();
for (const link of document.querySelectorAll('.index-list a[href^="#"]')) {
  const id = decodeURIComponent(link.getAttribute('href').slice(1));
  if (!links.has(id)) links.set(id, []);
  links.get(id).push(link);
}
// Exactly one entry is lit: the last heading that has passed under the top bar (the first one
// above all of them, the last one at the bottom of the page), measured once per frame.
const targets = [...links.keys()].map((id) => document.getElementById(id)).filter(Boolean);
if (targets.length > 0) {
  let current = null;
  let queued = false;
  const light = () => {
    queued = false;
    const line = (document.querySelector('.bar')?.offsetHeight ?? 56) + 24;
    let lit = targets[0];
    for (const target of targets) {
      if (target.getBoundingClientRect().top > line) break;
      lit = target;
    }
    const root = document.documentElement;
    if (window.innerHeight + window.scrollY >= root.scrollHeight - 2) lit = targets.at(-1);
    if (lit === current) return;
    current = lit;
    for (const [id, items] of links) {
      for (const link of items) {
        if (id === lit.id) link.setAttribute('aria-current', 'true');
        else link.removeAttribute('aria-current');
      }
    }
  };
  const queue = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(light);
  };
  addEventListener('scroll', queue, { passive: true });
  addEventListener('resize', queue);
  addEventListener('hashchange', queue);
  light();
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
