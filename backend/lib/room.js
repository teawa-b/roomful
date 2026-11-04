import { parseInterests } from './interests.js';
import { placeTagTypes } from './qloo.js';

// Roomful: a room that exists only as a taste profile. A few favourites (bands, films, books, brands)
// become Qloo entities; Qloo says what rooms that audience loves (decor, ambience), who is on their
// playlist and which brands and films sit nearby; an LLM turns that into a room brief and an image
// prompt; a text-to-image model paints it; the live world model lets you walk in. Every design choice
// cites the Qloo signal behind it, checked the same way the studio checks a venue concept.

const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

export async function buildRoom({ qloo, llm, imageModel, text, emit, saveRender }) {
  const step = async (id, label, fn) => {
    emit({ type: 'step', id, label });
    try { const out = await fn(); emit({ type: 'step_done', id, summary: out?.summary || '' }); return out?.data; }
    catch (error) { emit({ type: 'step_error', id, message: error.message }); return null; }
  };
  const signals = new Map();
  const record = (name, kind, extra = {}) => { if (name && !signals.has(norm(name))) signals.set(norm(name), { name, kind, ...extra }); };

  // 1. Favourites → Qloo entities (tags when nothing matches, e.g. "natural wine").
  const phrases = parseInterests(text);
  // A hit only counts if it shares a real word with what was typed, so "Monocle magazine" can't become "Elle Magazine".
  const generic = new Set(['the', 'a', 'an', 'and', 'of', 'magazine', 'band', 'film', 'films', 'movie', 'movies', 'book', 'books', 'brand', 'show', 'tv', 'series', 'novel', 'novels', 'music', 'album']);
  const sameThing = (phrase, name) => { const said = norm(phrase).split(' ').filter(w => !generic.has(w)), got = new Set(norm(name).split(' ')); return said.some(w => got.has(w)); };
  const seeds = await step('resolve', 'Finding your favourites in Qloo', async () => {
    const found = [];
    for (const phrase of phrases) {
      const hits = (await qloo.search(phrase, undefined, 3)).filter(e => (e.popularity == null || e.popularity > 0.15) && sameThing(phrase, e.name));
      if (hits.length) { found.push({ phrase, ...hits[0] }); record(hits[0].name, hits[0].type, { id: hits[0].id, seed: true }); continue; }
      const tag = (await qloo.tags(phrase)).find(t => sameThing(phrase, t.name));
      if (tag) found.push({ phrase, name: tag.name, id: tag.id, type: 'tag', tag: true });
    }
    if (!found.length) throw new Error('Qloo could not match any of those. Try names of bands, films, books, brands or places.');
    return { data: found, summary: found.map(f => f.name).join(', ') };
  });
  if (!seeds) { emit({ type: 'error', message: 'No favourites could be resolved.' }); return; }
  const ids = seeds.filter(s => !s.tag).map(s => s.id);
  if (!ids.length) { emit({ type: 'error', message: 'Those matched only as tags; add at least one artist, film, book, brand or place.' }); return; }

  // 2. What Qloo knows about people with these tastes: rooms, playlist, brands, screen and shelf.
  const taste = {};
  await step('taste', 'Asking Qloo what rooms people with your taste love', async () => {
    const [decor, ambience, interests] = await Promise.all([qloo.fanTags(ids, placeTagTypes.decor, 10), qloo.fanTags(ids, placeTagTypes.ambience, 10), qloo.fanTags(ids, placeTagTypes.interests, 8)]);
    Object.assign(taste, { decor, ambience, interests });
    [...decor, ...ambience, ...interests].forEach(t => record(t.name, 'tag', { id: t.id, affinity: t.affinity }));
    return { summary: `decor: ${decor.slice(0, 4).map(t => t.name).join(', ')} · mood: ${ambience.slice(0, 3).map(t => t.name).join(', ')}` };
  });
  await step('culture', 'Building the playlist, the shelf and the screen', async () => {
    const own = new Set(ids);
    const grab = async (type, take) => (await qloo.fanEntities(ids, type, { take })).filter(e => !own.has(e.id));
    const [artist, brand, movie, book] = await Promise.all([grab('artist', 8), grab('brand', 6), grab('movie', 4), grab('book', 4)]);
    Object.assign(taste, { artist, brand, movie, book });
    [...artist, ...brand, ...movie, ...book].forEach(e => record(e.name, e.type, { id: e.id, affinity: e.affinity }));
    return { summary: `playlist: ${artist.slice(0, 3).map(e => e.name).join(', ')} · brands: ${brand.slice(0, 2).map(e => e.name).join(', ')}` };
  });
  await step('who', 'Reading who shares this taste', async () => {
    const demo = await qloo.demographics({ entities: ids });
    const bands = ['24_and_younger', '25_to_29', '30_to_34', '35_to_44', '45_to_54', '55_and_older'];
    const age = Object.fromEntries(bands.map(b => [b, Math.round(ids.reduce((s, id) => s + (demo[id]?.age?.[b] || 0), 0) / ids.length * 100) / 100]));
    taste.demographics = { age };
    return { summary: `strongest age band: ${bands.reduce((a, b) => age[b] > age[a] ? b : a).replace(/_/g, ' ')}` };
  });

  // 3. The brief. The model may only cite names Qloo returned; anything else is flagged.
  const names = list => (list || []).slice(0, 8).map(x => x.name);
  const facts = { favourites: seeds.map(s => s.name), decor: names(taste.decor), ambience: names(taste.ambience), interests: names(taste.interests), playlist: names(taste.artist), brands: names(taste.brand), films: names(taste.movie), books: names(taste.book) };
  let brief = null;
  if (llm) {
    brief = await step('brief', 'Writing the room', async () => {
      const session = llm.create({
        system: 'You are an interior designer who works only from evidence, and no two of your rooms look alike. Reply with JSON only. Write plainly and never use em dashes.',
        tools: [],
        // The room is always their retreat: a private room for one, somewhere to settle, with light to look at. Its mood
        // follows the taste (soft and quiet for one person, dark and loud for another), so it never defaults to a spa. What kind
        // of room, where, its light and palette come from what this person loves, decided before the painting is
        // described. Left to itself, the model paints one cosy default every time
        // (walnut, brass, amber lamps, a turntable and a poster), so that look is ruled out unless the taste asks for it.
        user: `Design a retreat for a person who loves ${facts.favourites.join(', ')}: a private place of their own where they go to switch off and come back with a clear head. Switching off looks different for everyone: for one person it is soft and quiet, for another it is dark, loud and intense. Let the mood come from the taste, not from the idea of a spa. Whatever form it takes, it must be:
1. a private room for one person, indoors or sheltered (never a bar, club, restaurant, gym, public pool, shop or any kind of venue)
2. somewhere to settle that this person would actually choose, clearly in view: a bed, a window seat, a gaming chair, a studio chair at a mixing desk, a low leather couch, a car seat, floor cushions
3. lit by a window or another source of light worth looking at
4. small enough to feel held, like a room you could walk around in a few steps
The favourites are the strongest signal: think about the worlds they come from (their places, eras, landscapes, materials, colours, light and textures), not just the things themselves.
Qloo adds what people with this taste love: rooms tagged ${facts.decor.join(', ')} (decor, from venues they rate) and ${facts.ambience.join(', ')} (mood); interests ${facts.interests.join(', ')}; a playlist leaning ${facts.playlist.join(', ')}; brands ${facts.brands.join(', ')}; films ${facts.films.join(', ')}; books ${facts.books.join(', ')}. Use the tags that fit these favourites and skip the generic ones.
Make deliberate choices that only this taste would make:
- what kind of retreat it is and where, whatever this taste suggests: e.g. a bedroom in a Tokyo flat, a window seat in a mountain cabin, a home studio booth in red light, a garage with a car under a cover, a rooftop room above a city at night, an attic under the eaves, a sunroom full of plants, a concrete loft with a sound system, a reading nook, a teenage bedroom, a houseboat cabin
- its architecture and the place to settle
- the time of day and the light: morning sun, noon glare, overcast daylight, golden hour, blue hour, neon at night, candlelight and so on
- a palette of two or three colours that this taste suggests
Avoid the default cosy look (warm amber lamplight, walnut sideboards, brass, velvet, a turntable with vinyl, a framed poster) unless these favourites specifically point there. Objects should come from the favourites and Qloo's lists, not stand in for them.
Reply as JSON: {"space": "what kind of retreat, in a few words", "setting": "where it is and its architecture, one line", "light": "time of day and light, one line", "palette": "two or three colours", "name": "a two or three word room name", "tagline": "one line", "brief": "two sentences on how the room feels and what you do in it", "image_prompt": "60-100 words for a photoreal interior photograph of this room at eye level, with the place to settle in view, built from the space, setting, light and palette above: name the materials, furniture and two or three objects that come straight from the tastes above. Positive phrasing, no readable text or signs, no people.", "design_choices": [4-6 of {"element": "Space|Lighting|Seating|Materials|Walls|Objects|Soundtrack|Screen|Shelf", "choice": "one sentence", "signals": ["exact Qloo names from the lists above, or the favourites"]}], "first_track": "one artist from the playlist to play first"}`
      });
      const { text: out } = await session.next();
      const json = JSON.parse(out.slice(out.indexOf('{'), out.lastIndexOf('}') + 1));
      const check = list => (Array.isArray(list) ? list : [list]).filter(Boolean).map(raw => ({ name: String(raw), grounded: signals.has(norm(raw)) }));
      const concept = { name: String(json.name || 'Your room').slice(0, 60), tagline: String(json.tagline || '').slice(0, 160), brief: String(json.brief || '').slice(0, 600), image_prompt: String(json.image_prompt || '').slice(0, 1200), design_choices: (json.design_choices || []).slice(0, 6).map(d => ({ element: String(d.element || ''), choice: String(d.choice || ''), signals: check(d.signals) })), first_track: String(json.first_track || facts.playlist[0] || '') };
      return { data: concept, summary: concept.name };
    });
  }
  if (!brief) {
    // Scripted fallback: a template over the strongest signals.
    const d = facts.decor.slice(0, 2), m = facts.ambience.slice(0, 2);
    brief = {
      name: `${m[0] || 'Quiet'} room`, tagline: `A room shaped by ${facts.favourites.slice(0, 2).join(' and ')}.`, brief: `Built around ${d.join(' and ').toLowerCase() || 'warm natural'} finishes with a ${m.join(', ').toLowerCase() || 'calm'} mood.`,
      image_prompt: `Photorealistic interior photograph, eye level, of a small private room of their own with a place to sit by a window, with ${d.join(' and ').toLowerCase() || 'warm wood'} finishes, ${m.join(', ').toLowerCase() || 'calm'} mood, soft lamplight, a record player and shelves of books and vinyl, a framed poster without readable text, a worn leather armchair, plants by the window. No people, no readable text.`,
      design_choices: [d.length && { element: 'Materials', choice: `Finishes around ${d.join(' and ')}.`, signals: d.map(n => ({ name: n, grounded: true })) }, m.length && { element: 'Lighting', choice: `Lit for a ${m.join(' / ').toLowerCase()} mood.`, signals: m.map(n => ({ name: n, grounded: true })) }, facts.playlist.length && { element: 'Soundtrack', choice: `Starts with ${facts.playlist.slice(0, 3).join(', ')}.`, signals: facts.playlist.slice(0, 3).map(n => ({ name: n, grounded: true })) }].filter(Boolean),
      first_track: facts.playlist[0] || '', scripted: true
    };
  }

  // 4. Paint it, while 5. the same favourites go to an LLM alone, so the page can show what Qloo changes.
  let render = null;
  const baseline = llm ? step('baseline', 'Asking the same question without Qloo', async () => {
    const session = llm.create({ system: 'You are an interior designer. Answer from your own knowledge only. Reply with JSON only.', tools: [], user: `Design one private room for a person who loves ${facts.favourites.join(', ')}. Give exactly 8 picks as JSON: {"picks":[{"kind":"decor","name":"..."},...]} with kinds: three "decor" (short decor or mood descriptors, e.g. "Exposed Brick", "Cozy"), three "artist" (for the playlist), two "brand" (objects or products in the room). Names only, each 1-4 words.` });
    const { text: out } = await session.next();
    const picks = JSON.parse(out.slice(out.indexOf('{'), out.lastIndexOf('}') + 1)).picks.slice(0, 8);
    // "ranked": Qloo returned it for this taste in this run; "known": Qloo knows it but doesn't rank it for this taste.
    const checks = await Promise.all(picks.map(async p => {
      const name = String(p.name || '').slice(0, 60), kind = ['decor', 'artist', 'brand'].includes(p.kind) ? p.kind : 'decor';
      const hit = signals.get(norm(name));
      let match = hit?.name || null;
      if (!hit) {
        try {
          const found = kind === 'decor' ? await qloo.tags(name) : await qloo.search(name, kind, 3);
          const same = found.find(f => norm(f.name) === norm(name)) || found.find(f => norm(f.name).includes(norm(name)) || norm(name).includes(norm(f.name)));
          if (same) match = same.name;
        } catch {}
      }
      return { kind, name, verdict: hit ? 'ranked' : match ? 'known' : 'unknown', match };
    }));
    const counts = { ranked: checks.filter(c => c.verdict === 'ranked').length, known: checks.filter(c => c.verdict === 'known').length, unknown: checks.filter(c => c.verdict === 'unknown').length };
    return { data: { model: session.model, picks: checks, counts, total: checks.length }, summary: `${counts.ranked} of ${checks.length} picks hold up for this taste` };
  }) : null;
  if (imageModel?.generate) {
    render = await step('paint', 'Painting the room', async () => {
      const result = await imageModel.generate({ prompt: brief.image_prompt });
      const saved = await saveRender({ ...result, prompt: brief.image_prompt, aspect: '3:2', signals: brief.design_choices.flatMap(d => d.signals.map(s => s.name)) });
      return { data: saved, summary: result.model };
    });
  }
  emit({ type: 'final', concept: brief, render, taste: { ...taste, seeds }, signals: [...signals.values()], baseline: await baseline });
}
