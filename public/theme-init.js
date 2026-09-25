// Applies the saved theme before first paint (no flash). Keep in sync with src/lib/themes.ts.
try {
  var ids = ['amethyst', 'sapphire', 'jade', 'ember', 'crimson', 'graphite', 'slate', 'lilac', 'sand',
    'fluent-light', 'fluent-dark', 'cupertino-light', 'cupertino-dark', 'material-light', 'material-dark'];
  var t = localStorage.getItem('mneme-theme');
  if (t === 'light') t = 'slate';
  else if (t === 'dark' || !t || (t !== 'system' && ids.indexOf(t) < 0)) t = 'amethyst';
  if (t === 'system') t = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'amethyst' : 'slate';
  document.documentElement.setAttribute('data-theme', t);
} catch (e) {
  document.documentElement.setAttribute('data-theme', 'amethyst');
}
