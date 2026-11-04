// The room's soundtrack, carried into the 3D pages: ?music=Artist|Artist|…&at=<index>&yt=<video id> is what was
// playing on the room page. A small player sits under the header with the artist, Next and an always-visible mute
// button. Browsers often hold back sound until the page is touched, so the first tap or key press starts it.
// The YouTube embed is driven by postMessage (enablejsapi), so no YouTube script is loaded into the page.
const YT = 'https://www.youtube-nocookie.com';
const icons = {
  on: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9v6h4l5 4V5L8 9H4z" fill="currentColor"/><path d="M16 8.5a5 5 0 0 1 0 7M18.5 6a8.5 8.5 0 0 1 0 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  off: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9v6h4l5 4V5L8 9H4z" fill="currentColor"/><path d="M16.5 9.5l5 5m0-5l-5 5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  next: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l9 6-9 6V6z" fill="currentColor"/><rect x="16" y="6" width="2.5" height="12" rx="1" fill="currentColor"/></svg>'
};
const store = { get: k => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch {} } };

export function startMusic() {
  const params = new URLSearchParams(location.search);
  const artists = (params.get('music') || '').split('|').map(s => s.trim().slice(0, 80)).filter(Boolean).slice(0, 8);
  if (!artists.length) return null;
  let at = Math.min(Math.max(0, Number(params.get('at')) || 0), artists.length - 1);
  let first = /^[A-Za-z0-9_-]{11}$/.test(params.get('yt') || '') ? params.get('yt') : null;
  let muted = store.get('roomful-muted') === '1';

  const css = Object.assign(document.createElement('link'), { rel: 'stylesheet', href: '/music.css' });
  document.head.append(css);
  const box = document.createElement('div'); box.className = 'music'; box.setAttribute('role', 'region'); box.setAttribute('aria-label', 'Music');
  const frame = document.createElement('iframe');
  frame.className = 'music-video'; frame.title = 'Music'; frame.allow = 'autoplay; encrypted-media'; frame.referrerPolicy = 'strict-origin-when-cross-origin';
  const meta = document.createElement('div'); meta.className = 'music-meta';
  const label = document.createElement('span'); label.textContent = 'Now playing';
  const name = document.createElement('b');
  meta.append(label, name);
  const next = document.createElement('button'); next.type = 'button'; next.className = 'music-btn'; next.innerHTML = icons.next; next.setAttribute('aria-label', 'Next song'); next.title = 'Next song';
  const mute = document.createElement('button'); mute.type = 'button'; mute.className = 'music-btn music-mute';
  box.append(frame, meta, ...(artists.length > 1 ? [next] : []), mute);
  document.body.append(box);

  const cmd = (func, args = []) => frame.contentWindow?.postMessage(JSON.stringify({ event: 'command', func, args }), YT);
  const showMute = () => {
    mute.innerHTML = muted ? icons.off : icons.on;
    mute.setAttribute('aria-pressed', String(muted)); mute.setAttribute('aria-label', muted ? 'Unmute music' : 'Mute music'); mute.title = muted ? 'Unmute' : 'Mute';
    box.classList.toggle('muted', muted);
  };
  showMute();

  let token = 0;
  async function load() {
    const mine = ++token;
    name.textContent = artists[at];
    let id = first; first = null;
    if (!id) {
      try {
        const res = await fetch(`/api/yt?q=${encodeURIComponent(`${artists[at]} official audio`)}`);
        id = (await res.json()).id;
      } catch {}
    }
    if (mine !== token) return;
    if (!/^[A-Za-z0-9_-]{11}$/.test(id || '')) { label.textContent = 'Couldn’t load'; return; }
    label.textContent = 'Now playing';
    const q = new URLSearchParams({ autoplay: '1', enablejsapi: '1', playsinline: '1', rel: '0', origin: location.origin, ...(muted ? { mute: '1' } : {}) });
    frame.src = `${YT}/embed/${id}?${q}`;
  }
  // Ask the player to report its state, so the next song starts when one ends.
  frame.addEventListener('load', () => frame.contentWindow?.postMessage(JSON.stringify({ event: 'listening', id: 'roomful' }), YT));
  addEventListener('message', e => {
    if (e.origin !== YT || e.source !== frame.contentWindow) return;
    let data; try { data = JSON.parse(e.data); } catch { return; }
    if (data.event === 'onStateChange' ? data.info === 0 : data.info?.playerState === 0) { at = (at + 1) % artists.length; load(); }
  });
  next.addEventListener('click', () => { at = (at + 1) % artists.length; load(); });
  mute.addEventListener('click', () => { muted = !muted; store.set('roomful-muted', muted ? '1' : '0'); cmd(muted ? 'mute' : 'unMute'); if (!muted) cmd('playVideo'); showMute(); });
  // The first touch anywhere on the page lets the music start if the browser held it back.
  const wake = e => {
    if (box.contains(e.target)) return;
    removeEventListener('pointerdown', wake, true); removeEventListener('keydown', wake, true);
    cmd('playVideo'); if (!muted) cmd('unMute');
  };
  addEventListener('pointerdown', wake, true); addEventListener('keydown', wake, true);
  load();
  return { cmd };
}
