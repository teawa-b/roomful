import { tick, chime } from '/sound.js';
import { keepFresh } from '/fresh.js';
const $ = id => document.getElementById(id);
// Model-written text never shows an em or en dash used as punctuation (house style); a comma reads the same.
const tidy = v => typeof v === 'string' ? v.replace(/(\d)\s*–\s*(\d)/g, '$1-$2').replace(/\s*[—–]\s*/g, ', ') : v;
const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = tidy(text); return n; };
const safeUrl = v => { try { const u = new URL(v, location.origin); return ['https:', 'http:'].includes(u.protocol) ? u.href : ''; } catch { return ''; } };
let config = {}, render = null, concept = null, taste = null, running = false, playing = null;

function toast(text, ms = 4000) { $('toast').textContent = text; $('toast').hidden = !text; clearTimeout(toast.t); if (text) toast.t = setTimeout(() => { $('toast').hidden = true; }, ms); }
keepFresh(() => running || $('intro').hidden, toast);
async function api(path, body) {
  const res = await fetch(path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : undefined);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status}).`);
  return data;
}

// Likes: each favourite is added on its own (Enter, a comma or the Add button) and shown as a bubble.
const MAX_LIKES = 12, MAX_TEXT = 600;
let likes = [];
const clean = v => String(v).replace(/["“”]/g, '').replace(/\s+/g, ' ').trim().slice(0, 60);
// The server splits on commas and words like "and", but keeps quoted titles whole, so a like that contains one is quoted.
const likesText = (list = likes) => list.map(l => /[,;.!?\n]|\s(?:and|also|plus|as well as)\s/i.test(l) ? `"${l}"` : l).join(', ');
function renderLikes() {
  $('likes').replaceChildren(...likes.map(like => {
    const li = el('li', 'like'), x = el('button');
    li.append(el('span', '', like), x);
    x.type = 'button'; x.setAttribute('aria-label', `Remove ${like}`); x.innerHTML = '<i class="ph ph-x" aria-hidden="true"></i>';
    x.addEventListener('click', () => { li.classList.add('out'); setTimeout(() => { removeLike(like); $('text').focus(); }, 180); });
    return li;
  }));
  $('likes').hidden = !likes.length;
  $('text').placeholder = likes.length >= MAX_LIKES ? 'That’s the most you can add' : likes.length ? 'Add another…' : 'Type one, then press Enter';
  $('text').disabled = likes.length >= MAX_LIKES;
}
function addLikes(raw) {
  const parts = String(raw).split(/[,\n;]+/).map(clean).filter(Boolean);
  let added = 0;
  for (const part of parts) {
    if (likes.some(l => l.toLowerCase() === part.toLowerCase())) continue;
    if (likes.length >= MAX_LIKES) { toast(`You can add up to ${MAX_LIKES}.`); break; }
    if (likesText([...likes, part]).length > MAX_TEXT) { toast('That’s as much as fits. Make your spot, or remove one.'); break; }
    likes.push(part); added++;
  }
  if (added) { renderLikes(); tick(); }
  return added;
}
function removeLike(like) { likes = likes.filter(l => l !== like); renderLikes(); }
function setLikes(list) { likes = []; addLikes(list.join('\n')); renderLikes(); }
const showAdd = () => { $('add').hidden = !$('text').value.trim(); };
function commitTyped() { const v = $('text').value; if (!v.trim()) return false; addLikes(v); $('text').value = ''; showAdd(); return true; }
$('text').addEventListener('input', () => { if (/[,\n]/.test($('text').value)) commitTyped(); showAdd(); });
$('text').addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.isComposing) {
    // Enter adds what's typed; with nothing typed and at least one like, it makes the spot.
    if (commitTyped() || !likes.length) e.preventDefault();
  } else if (e.key === 'Backspace' && !$('text').value && likes.length) {
    e.preventDefault(); removeLike(likes[likes.length - 1]);
  }
});
$('text').addEventListener('paste', e => {
  const t = e.clipboardData?.getData('text') || '';
  if (/[,\n;]/.test(t)) { e.preventDefault(); addLikes($('text').value + t); $('text').value = ''; showAdd(); }
});
$('add').addEventListener('click', () => { commitTyped(); $('text').focus(); });

// An example replays its recorded run instantly; typing your own favourites builds live.
document.querySelectorAll('[data-ex]').forEach(b => b.addEventListener('click', () => { setLikes(b.dataset.ex.split(', ')); build(b.dataset.ex, b.dataset.demo); }));
$('ask').addEventListener('submit', e => {
  e.preventDefault(); commitTyped();
  if (!likes.length) { toast('Add at least one thing you love first.'); $('text').focus(); return; }
  build(likesText());
});
$('again').addEventListener('click', () => { $('build').hidden = true; $('intro').hidden = false; scrollTo({ top: 0, behavior: 'smooth' }); $('text').focus(); });
$('more').addEventListener('click', () => {
  const open = $('r-more').hidden;
  $('r-more').hidden = !open; $('more').setAttribute('aria-expanded', String(open)); $('more').textContent = open ? 'Show less' : 'Read more';
  if (open) $('r-more').scrollIntoView({ behavior: 'smooth', block: 'start' });
});
// Surprise me: a few hand-picked tastes to start from, never the same one twice in a row.
const surprises = [
  'Studio Ghibli, Nujabes, Mary Oliver, Muji', 'Wong Kar-wai, Khruangbin, Haruki Murakami, Aesop',
  'Frank Ocean, Moonlight, Kinfolk, Patagonia', 'Björk, Kyoto, Ryuichi Sakamoto, Arc’teryx',
  'Fleetwood Mac, Wes Anderson, Joan Didion, Le Creuset', 'Bon Iver, The Lord of the Rings, Mary Oliver, Filson',
  'Erykah Badu, Spike Lee, Toni Morrison, Telfar', 'Brian Eno, Lost in Translation, Kazuo Ishiguro, Byredo'
];
$('surprise').addEventListener('click', () => {
  const choices = surprises.filter(s => s !== likes.join(', '));
  $('text').value = ''; showAdd(); setLikes(choices[Math.floor(Math.random() * choices.length)].split(', '));
  for (const [n, c] of [[$('likes'), 'filled'], [$('surprise'), 'spun']]) { n.classList.remove(c); void n.offsetWidth; n.classList.add(c); }
  $('text').focus(); tick();
});
// The menu: a small sheet under the button; Escape, a click outside or a link closes it.
const menu = open => { $('menu-list').hidden = !open; $('menu-btn').setAttribute('aria-expanded', String(open)); $('menu-btn').firstElementChild.className = `ph ${open ? 'ph-x' : 'ph-list'}`; };
$('menu-btn').addEventListener('click', e => { e.stopPropagation(); menu($('menu-list').hidden); });
document.addEventListener('click', e => { if (!$('menu-list').hidden && !e.target.closest('.menu')) menu(false); });
document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('menu-list').hidden) { menu(false); $('menu-btn').focus(); } });
$('menu-list').querySelectorAll('[data-close]').forEach(a => a.addEventListener('click', e => {
  menu(false);
  if ($('intro').hidden) return; // on a result, the plain link reloads the home page
  e.preventDefault(); const target = document.querySelector(a.hash);
  target.scrollIntoView({ behavior: 'smooth' }); if (a.hash === '#ask') setTimeout(() => $('text').focus({ preventScroll: true }), 400);
}));
$('change').addEventListener('click', () => { $('refine').hidden = !$('refine').hidden; if (!$('refine').hidden) $('refine-input').focus(); });

// Walking inside works as it does in Openhere: fal's real-time world model (Lingbot World 2, /live) first; a World
// Labs Marble world (/walk) without it; otherwise the painting lifted into 3D on the spot (fal's MoGe-2), where this
// example's 3D room ships with the site, so it opens instantly.
const worlds = {}; // example slug → a 3D room shipped in frontend/img, so it opens instantly
let world = null;

async function build(text, demo = null) {
  if (!text || running) return;
  if (!demo && !config.qloo) return toast('This server has no Qloo key yet.');
  running = true; render = null; concept = null; taste = null; world = worlds[demo] || null;
  tick();
  $('demo-note').hidden = !demo;
  $('intro').hidden = true; $('build').hidden = false; $('build').classList.remove('complete');
  scrollTo({ top: 0 });
  $('steps').replaceChildren(); $('r-body').hidden = true; $('hero-actions').hidden = true; $('refine').hidden = true;
  $('hero-img').removeAttribute('src'); $('hero').classList.remove('ready'); $('hero-shimmer').hidden = false; $('hero-shimmer-text').textContent = 'Reading your taste…';
  $('r-kicker').textContent = 'Reading your taste'; $('r-name').textContent = text.replace(/"/g, '').split(',').slice(0, 3).map(t => t.trim()).join(', '); $('r-tag').textContent = '';
  const pending = new Map();
  try {
    const stall = new AbortController();
    let watchdog = setTimeout(() => stall.abort(), 50000);
    const res = await fetch('/api/room', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(demo ? { text, demo, pace: new URLSearchParams(location.search).get('pace') } : { text }), signal: stall.signal });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Your spot could not start.');
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = '';
    for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      clearTimeout(watchdog); watchdog = setTimeout(() => stall.abort(), 50000);
      buffer += value;
      let i;
      while ((i = buffer.indexOf('\n\n')) >= 0) {
        const line = buffer.slice(0, i).split('\n').find(l => l.startsWith('data: ')); buffer = buffer.slice(i + 2);
        if (line) handle(JSON.parse(line.slice(6)), pending);
      }
    }
    clearTimeout(watchdog);
  } catch (error) { failed(error.name === 'AbortError' ? 'The server stopped responding. Try again.' : error.message); }
  finally { running = false; if (!concept) { $('hero-shimmer').hidden = true; if ($('r-kicker').textContent !== 'Something went wrong') failed('Your spot stopped before it was finished. Try again.'); } }
}
function failed(message) {
  $('r-kicker').textContent = 'Something went wrong'; $('r-name').textContent = 'That didn’t work'; $('r-tag').textContent = message;
  $('hero-shimmer').hidden = true;
  const again = el('button', 'btn quiet', 'Try another taste'); again.addEventListener('click', () => $('again').click());
  $('hero-actions').replaceChildren(again); $('hero-actions').hidden = false;
}

function handle(ev, pending) {
  if (ev.type === 'step') { const li = el('li', 'busy'); li.append(el('span', 'dot'), el('span', '', ev.label)); $('steps').append(li); pending.set(ev.id, li); $('r-kicker').textContent = ev.label; $('hero-shimmer-text').textContent = ev.id === 'paint' ? 'Painting your spot. Breathe in slowly… about 30 seconds.' : 'Reading your taste…'; }
  else if (ev.type === 'step_done') { const li = pending.get(ev.id); if (li) { li.className = 'done'; if (ev.summary) li.append(el('small', '', ev.summary)); } }
  else if (ev.type === 'step_error') { const li = pending.get(ev.id); if (li) { li.className = 'err'; li.append(el('small', '', ev.message)); } }
  else if (ev.type === 'final') show(ev);
  else if (ev.type === 'error') failed(ev.message);
}

function tags(list) {
  return list.map(s => el('span', `tag${s.grounded === false ? ' no' : ''}`, s.grounded === false ? `${s.name} (unverified)` : s.name));
}

function show(ev) {
  concept = ev.concept; render = ev.render; taste = ev.taste;
  const seeds = taste.seeds.map(s => s.name);
  $('r-kicker').textContent = `${concept.scripted ? 'Scripted. ' : ''}A meditation spot for someone who loves ${seeds.slice(0, 3).join(', ')}${seeds.length > 3 ? ' and more' : ''}`;
  $('r-name').textContent = tidy(concept.name); $('r-tag').textContent = tidy(concept.tagline); $('r-brief').textContent = tidy(concept.brief);
  // In short: the brief's first sentence and a handful of the taste behind it; the rest waits behind Read more.
  const brief = tidy(concept.brief || '');
  $('r-summary').textContent = (brief.match(/^.+?[.!?](?=\s|$)/) || [brief])[0];
  $('r-more').hidden = true; $('more').setAttribute('aria-expanded', 'false'); $('more').textContent = 'Read more';
  const cited = [...new Set(concept.design_choices.flatMap(d => d.signals).filter(s => s.grounded).map(s => s.name))].slice(0, 5);
  $('r-chips').replaceChildren(...tags(cited.map(name => ({ name }))));
  // Six-column grid: the first two choices take half a row each, the rest a third, and the last row always
  // fills the width (one leftover spans the row, two leftovers split it), so there is never an empty cell.
  const n = concept.design_choices.length, rest = Math.max(0, n - 2), left = rest % 3;
  const span = i => i < 2 ? (n === 1 ? 6 : 3) : i >= n - left ? 6 / left : 2;
  $('r-choices').replaceChildren(...concept.design_choices.map((d, i) => {
    const li = el('li', `span-${span(i)}`), t = el('div', 'tags');
    li.style.animationDelay = `${i * 60}ms`;
    t.append(...tags(d.signals));
    li.append(el('h3', '', d.element), el('p', '', d.choice), t); return li;
  }));
  const actions = [];
  if (render?.url) {
    const img = $('hero-img'); img.src = safeUrl(render.url);
    img.decode().catch(() => {}).finally(() => { $('hero').classList.add('ready'); $('hero-shimmer').hidden = true; chime(); });
    const walkable = config.liveWorld || config.world || world || config.room3d;
    if (walkable) actions.push($('walk'));
    actions.push($('change'));
    $('walk').hidden = !walkable;
    $('walk').textContent = config.liveWorld ? 'Walk inside' : 'Walk inside in 3D';
  } else {
    $('hero-shimmer').hidden = true;
    $('hero').classList.add('ready');
  }
  $('hero-actions').replaceChildren(...actions); $('hero-actions').hidden = !actions.length;
  playlist();
  charts();
  compare(ev.baseline);
  $('build').classList.add('complete');
  $('r-body').hidden = false;
}

// The playlist: Qloo's artists for this taste, played through YouTube.
function playlist() {
  const artists = taste.artist || [];
  $('player').hidden = !artists.length; if (!artists.length) return;
  const first = artists.find(a => a.name === concept.first_track) || artists[0];
  $('tracks').replaceChildren(...artists.slice(0, 8).map(a => {
    const li = el('li'), b = el('button', `track${a === first ? ' on' : ''}`, a.name);
    b.title = a.detail || ''; b.addEventListener('click', () => { document.querySelectorAll('.track').forEach(x => x.classList.toggle('on', x === b)); play(a.name); });
    li.append(b); return li;
  }));
  play(first.name);
}
async function play(name) {
  $('yt').replaceChildren(el('p', 'yt-status', `Finding ${name}…`));
  try {
    const { id } = await api(`/api/yt?q=${encodeURIComponent(`${name} official audio`)}`);
    if (!/^[A-Za-z0-9_-]{11}$/.test(id)) throw new Error('Bad video id.');
    playing = { name, id };
    const f = el('iframe'); f.src = `https://www.youtube-nocookie.com/embed/${id}?autoplay=1&rel=0&enablejsapi=1&origin=${encodeURIComponent(location.origin)}`;
    f.allow = 'autoplay; encrypted-media; picture-in-picture'; f.referrerPolicy = 'strict-origin-when-cross-origin'; f.title = `${name} on YouTube`;
    $('yt').replaceChildren(f);
  } catch (error) { $('yt').replaceChildren(el('p', 'yt-status', `Couldn't load ${name}. ${error.message}`)); }
}

// With and without Qloo: an LLM's own picks for the same favourites, each placed against Qloo's results.
function compare(b) {
  $('r-compare').hidden = !b?.picks?.length; if (!b?.picks?.length) return;
  const label = { ranked: 'Holds up', known: 'Real, not ranked for this taste', unknown: 'Not in Qloo' };
  $('cmp-score').textContent = `Without Qloo, ${b.counts.ranked} of ${b.total} picks hold up for this taste`;
  $('cmp-list').replaceChildren(...b.picks.map(p => {
    const li = el('li', p.verdict);
    li.append(el('span', 'cmp-name', p.name), el('span', 'cmp-kind', p.kind), el('span', 'cmp-verdict', label[p.verdict] + (p.match && p.match !== p.name ? ` (Qloo: ${p.match})` : '')));
    return li;
  }));
  $('cmp-foot').textContent = `LLM alone: ${b.model}. Everything in the spot above came from Qloo's results; anything that didn't is marked unverified.`;
}

// Qloo's ranked lists, plainly: the name and its affinity score, strongest first.
function ranked(title, items) {
  const rows = (items || []).slice(0, 5).filter(x => x.name);
  if (!rows.length) return null;
  const col = el('div', 'taste-col'), list = el('ol');
  col.append(el('h3', '', title));
  rows.forEach(x => { const li = el('li'), score = x.affinity ?? x.popularity; li.append(el('span', '', x.name), el('span', '', score != null ? Number(score).toFixed(2) : '')); list.append(li); });
  col.append(list);
  return col;
}
function charts() {
  const list = [
    ranked('Rooms they rate', taste.decor), ranked('The mood', taste.ambience),
    ranked('On the shelf', taste.book), ranked('On the screen', taste.movie), ranked('Brands', taste.brand)
  ].filter(Boolean);
  $('chart-list').replaceChildren(...list); $('r-charts').hidden = !list.length;
}

// The song carries into the 3D page (see music.js), and pauses here so it doesn't play twice.
function soundtrack() {
  const artists = (taste?.artist || []).slice(0, 8).map(a => a.name);
  if (!artists.length) return {};
  const name = playing?.name.replace(/ official audio$/, '');
  const at = Math.max(0, artists.indexOf(name));
  $('yt').querySelector('iframe')?.contentWindow?.postMessage(JSON.stringify({ event: 'command', func: 'pauseVideo', args: [] }), 'https://www.youtube-nocookie.com');
  return { music: artists.join('|'), at: String(at), ...(playing?.id && artists[at] === name ? { yt: playing.id } : {}) };
}
$('walk').addEventListener('click', () => {
  if (!render) return;
  const music = soundtrack();
  if (config.liveWorld) {
    // The painting's own link too, so any server instance can start the walk (see /api/live/start).
    const q = new URLSearchParams({ render: render.id, name: concept.name, tagline: concept.tagline, ...(/^https:/.test(render.url) ? { img: render.url } : {}), ...music });
    return window.open(`/live?${q}`, '_blank', 'noopener');
  }
  if (config.world) return window.open(`/walk?${new URLSearchParams({ render: render.id, name: concept.name, ...music })}`, '_blank', 'noopener');
  if (world) return window.open(`/room3d?${new URLSearchParams({ room: world, name: concept.name, ...music })}`, '_blank', 'noopener');
  window.open(`/room3d?${new URLSearchParams({ img: render.url, name: concept.name, ...music })}`, '_blank', 'noopener');
});
$('refine').addEventListener('submit', async e => {
  e.preventDefault();
  const instruction = $('refine-input').value.trim(); if (!instruction || !render) return;
  const button = $('refine').querySelector('button'); button.disabled = true; button.textContent = 'Repainting…';
  $('hero').classList.remove('ready'); $('hero-shimmer').hidden = false; $('hero-shimmer-text').textContent = 'Repainting your spot…';
  try {
    const { render: next } = await api('/api/refine', { renderId: render.id, instruction });
    render = next; const img = $('hero-img'); img.src = safeUrl(next.url);
    await img.decode().catch(() => {});
    $('refine-input').value = '';
  } catch (error) { toast(error.message); }
  finally { $('hero').classList.add('ready'); $('hero-shimmer').hidden = true; button.disabled = false; button.textContent = 'Repaint'; }
});

const opened = performance.now();
try { config = await api('/api/config'); } catch { toast('Could not reach the server.'); }
// The loading screen lifts once the page can be used and the first painting is ready (or after 2.5 seconds, so a
// slow image never holds it up), and stays at least long enough for one gentle breath in rather than a flicker.
{
  const hero = document.querySelector('.hero-art img');
  await Promise.race([hero?.decode().catch(() => {}), new Promise(r => setTimeout(r, 2500))]);
  await new Promise(r => setTimeout(r, Math.max(0, 1400 - (performance.now() - opened))));
  $('splash').classList.add('done');
  setTimeout(() => $('splash').remove(), 900);
}
const preset = new URLSearchParams(location.search).get('q');
if (preset) { setLikes(preset.split(',')); build(preset); }
// Deep link to an example, e.g. /?demo=ghibli
const linked = new URLSearchParams(location.search).get('demo');
if (linked) document.querySelector(`[data-demo="${CSS.escape(linked)}"]`)?.click();
