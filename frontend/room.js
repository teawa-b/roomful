const $ = id => document.getElementById(id);
// Model-written text never shows an em or en dash used as punctuation (house style); a comma reads the same.
const tidy = v => typeof v === 'string' ? v.replace(/(\d)\s*–\s*(\d)/g, '$1-$2').replace(/\s*[—–]\s*/g, ', ') : v;
const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = tidy(text); return n; };
const safeUrl = v => { try { const u = new URL(v, location.origin); return ['https:', 'http:'].includes(u.protocol) ? u.href : ''; } catch { return ''; } };
let config = {}, render = null, concept = null, taste = null, running = false;

function toast(text, ms = 4000) { $('toast').textContent = text; $('toast').hidden = !text; clearTimeout(toast.t); if (text) toast.t = setTimeout(() => { $('toast').hidden = true; }, ms); }
async function api(path, body) {
  const res = await fetch(path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : undefined);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status}).`);
  return data;
}

// An example replays its recorded run instantly; typing your own favourites builds live.
document.querySelectorAll('[data-ex]').forEach(b => b.addEventListener('click', () => { $('text').value = b.dataset.ex; build(b.dataset.ex, b.dataset.demo); }));
$('ask').addEventListener('submit', e => { e.preventDefault(); const t = $('text').value.trim(); if (!t) { toast('Name a few things you love first.'); $('text').focus(); return; } build(t); });
$('again').addEventListener('click', () => { $('build').hidden = true; $('intro').hidden = false; scrollTo({ top: 0, behavior: 'smooth' }); $('text').focus(); });
$('change').addEventListener('click', () => { $('refine').hidden = !$('refine').hidden; if (!$('refine').hidden) $('refine-input').focus(); });

// Every room can be walked in 3D: the viewer lifts the painting into 3D on the spot (fal's MoGe-2). This example's
// 3D room ships with the site, so it opens instantly.
const worlds = { rain: 'room-rain-depth' };
let world = null;

async function build(text, demo = null) {
  if (!text || running) return;
  if (!demo && !config.qloo) return toast('This server has no Qloo key yet.');
  running = true; render = null; concept = null; taste = null; world = worlds[demo] || null;
  $('demo-note').hidden = !demo;
  $('intro').hidden = true; $('build').hidden = false; $('build').classList.remove('complete');
  scrollTo({ top: 0 });
  $('steps').replaceChildren(); $('r-body').hidden = true; $('hero-actions').hidden = true; $('refine').hidden = true;
  $('hero-img').removeAttribute('src'); $('hero').classList.remove('ready'); $('hero-shimmer').hidden = false; $('hero-shimmer-text').textContent = 'Reading your taste…';
  $('r-kicker').textContent = 'Reading your taste'; $('r-name').textContent = text.split(',').slice(0, 3).join(', '); $('r-tag').textContent = '';
  const pending = new Map();
  try {
    const stall = new AbortController();
    let watchdog = setTimeout(() => stall.abort(), 50000);
    const res = await fetch('/api/room', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(demo ? { text, demo, pace: new URLSearchParams(location.search).get('pace') } : { text }), signal: stall.signal });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'The room could not start.');
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
  finally { running = false; if (!concept) { $('hero-shimmer').hidden = true; if ($('r-kicker').textContent !== 'Something went wrong') failed('The room stopped before it was finished. Try again.'); } }
}
function failed(message) {
  $('r-kicker').textContent = 'Something went wrong'; $('r-name').textContent = 'That didn’t work'; $('r-tag').textContent = message;
  $('hero-shimmer').hidden = true;
  const again = el('button', 'btn quiet', 'Try another taste'); again.addEventListener('click', () => $('again').click());
  $('hero-actions').replaceChildren(again); $('hero-actions').hidden = false;
}

function handle(ev, pending) {
  if (ev.type === 'step') { const li = el('li', 'busy'); li.append(el('span', 'dot'), el('span', '', ev.label)); $('steps').append(li); pending.set(ev.id, li); $('r-kicker').textContent = ev.label; $('hero-shimmer-text').textContent = ev.id === 'paint' ? 'Painting your room. About 30 seconds…' : 'Reading your taste…'; }
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
  $('r-kicker').textContent = `${concept.scripted ? 'Scripted. ' : ''}A room for someone who loves ${seeds.slice(0, 3).join(', ')}${seeds.length > 3 ? ' and more' : ''}`;
  $('r-name').textContent = tidy(concept.name); $('r-tag').textContent = tidy(concept.tagline); $('r-brief').textContent = tidy(concept.brief);
  const cited = [...new Set(concept.design_choices.flatMap(d => d.signals).filter(s => s.grounded).map(s => s.name))].slice(0, 8);
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
    img.decode().catch(() => {}).finally(() => { $('hero').classList.add('ready'); $('hero-shimmer').hidden = true; });
    const walkable = world || config.room3d || config.liveWorld;
    if (walkable) actions.push($('walk'));
    actions.push($('change'));
    $('walk').hidden = !walkable;
    $('walk').textContent = world || config.room3d ? 'Walk inside in 3D' : 'Walk inside';
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
    const f = el('iframe'); f.src = `https://www.youtube-nocookie.com/embed/${id}?autoplay=1&rel=0`;
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
  $('cmp-foot').textContent = `LLM alone: ${b.model}. Everything in the room above came from Qloo's results; anything that didn't is marked unverified.`;
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

$('walk').addEventListener('click', () => {
  if (!render) return;
  if (world) return window.open(`/room3d?${new URLSearchParams({ room: world, name: concept.name })}`, '_blank', 'noopener');
  if (config.room3d) return window.open(`/room3d?${new URLSearchParams({ img: render.url, name: concept.name })}`, '_blank', 'noopener');
  const q = new URLSearchParams({ render: render.id, name: concept.name, tagline: concept.tagline });
  window.open(`/live?${q}`, '_blank', 'noopener');
});
$('refine').addEventListener('submit', async e => {
  e.preventDefault();
  const instruction = $('refine-input').value.trim(); if (!instruction || !render) return;
  const button = $('refine').querySelector('button'); button.disabled = true; button.textContent = 'Repainting…';
  $('hero').classList.remove('ready'); $('hero-shimmer').hidden = false; $('hero-shimmer-text').textContent = 'Repainting your room…';
  try {
    const { render: next } = await api('/api/refine', { renderId: render.id, instruction });
    render = next; const img = $('hero-img'); img.src = safeUrl(next.url);
    await img.decode().catch(() => {});
    $('refine-input').value = '';
  } catch (error) { toast(error.message); }
  finally { $('hero').classList.add('ready'); $('hero-shimmer').hidden = true; button.disabled = false; button.textContent = 'Repaint'; }
});

try { config = await api('/api/config'); } catch { toast('Could not reach the server.'); }
const preset = new URLSearchParams(location.search).get('q');
if (preset) { $('text').value = preset; build(preset); }
// Deep link to an example, e.g. /?demo=rain
const linked = new URLSearchParams(location.search).get('demo');
if (linked) document.querySelector(`[data-demo="${CSS.escape(linked)}"]`)?.click();
