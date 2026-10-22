import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createApp } from '../backend/server.js';

const QKEY = 'qloo-secret-key', OKEY = 'openrouter-secret-key';
async function serve(t, env, fetcher) {
  const server = http.createServer(createApp({ env, fetcher }));
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise(r => server.close(r)));
  return `http://127.0.0.1:${server.address().port}`;
}
const events = async res => (await res.text()).split('\n\n').map(c => c.split('\n').find(l => l.startsWith('data: '))).filter(Boolean).map(l => JSON.parse(l.slice(6)));

// A fake Qloo: two favourites resolve; the taste returns a few tags and entities; "Velvet" exists only as a tag.
function qloo(url, log) {
  const p = url.searchParams; log.push(Object.fromEntries(p));
  if (url.pathname === '/search') {
    const q = p.get('query').toLowerCase();
    const known = { radiohead: ['Radiohead', 'a-rh', 'urn:entity:artist'], muji: ['Muji', 'b-muji', 'urn:entity:brand'], 'thom yorke': ['Thom Yorke', 'a-ty', 'urn:entity:artist'] };
    const k = known[q];
    return Response.json({ results: k ? [{ name: k[0], entity_id: k[1], popularity: 0.9, types: [k[2]] }] : [] });
  }
  if (url.pathname === '/v2/tags') return Response.json({ results: { tags: /velvet/i.test(p.get('filter.query')) ? [{ tag_id: 't-velvet', name: 'Velvet' }] : [] } });
  const type = p.get('filter.type');
  if (type === 'urn:tag') return Response.json({ results: { tags: [{ tag_id: 't-concrete', name: 'Concrete', query: { affinity: 0.9 } }, { tag_id: 't-moody', name: 'Moody', query: { affinity: 0.8 } }] } });
  if (type === 'urn:demographics') return Response.json({ results: { demographics: [{ entity_id: 'a-rh', query: { age: { '25_to_29': 0.3 } } }] } });
  return Response.json({ results: { entities: [{ name: 'Portishead', entity_id: 'a-ph', types: [type], query: { affinity: 0.95 } }, { name: 'Aesop', entity_id: 'b-aesop', types: [type], query: { affinity: 0.9 } }] } });
}

test('roomful: favourites become Qloo taste, the brief cites it, and an LLM alone is checked against it', async t => {
  const log = [];
  const fetcher = async (url, options = {}) => {
    url = new URL(url);
    if (url.host === 'hackathon.api.qloo.com') return qloo(url, log);
    if (url.host === 'openrouter.ai') {
      const body = JSON.parse(options.body);
      const prompt = body.messages.at(-1).content;
      const content = /Give exactly 8 picks/.test(prompt)
        ? JSON.stringify({ picks: [{ kind: 'decor', name: 'Concrete' }, { kind: 'decor', name: 'Velvet' }, { kind: 'decor', name: 'Neon Haze' }, { kind: 'artist', name: 'Portishead' }, { kind: 'artist', name: 'Thom Yorke' }, { kind: 'brand', name: 'Imaginary Lamps' }] })
        : JSON.stringify({ name: 'Rain Room', tagline: 't', brief: 'b', image_prompt: 'p', design_choices: [{ element: 'Walls', choice: 'c', signals: ['Concrete', 'Made Up'] }], first_track: 'Portishead' });
      return Response.json({ choices: [{ message: { content } }] });
    }
    throw new Error(`Unexpected request to ${url}`);
  };
  const base = await serve(t, { QLOO_API_KEY: QKEY, OPENROUTER_API_KEY: OKEY, SITE: 'room' }, fetcher);
  const ev = await events(await fetch(`${base}/api/room`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'Radiohead, Muji' }) }));
  const final = ev.find(e => e.type === 'final');
  assert.deepEqual(final.taste.seeds.map(s => s.name), ['Radiohead', 'Muji']);
  // The taste comes from Qloo, signalled by the favourites.
  assert.ok(log.some(l => l['filter.type'] === 'urn:tag' && l['signal.interests.entities'] === 'a-rh,b-muji'));
  // Every cited name is checked: Qloo's "Concrete" is grounded, an invented one is not.
  assert.deepEqual(final.concept.design_choices[0].signals.map(s => [s.name, s.grounded]), [['Concrete', true], ['Made Up', false]]);
  // Without Qloo: picks Qloo returned for this taste hold up; real ones it didn't rank are "known"; the rest are not in Qloo.
  const verdicts = Object.fromEntries(final.baseline.picks.map(p => [p.name, p.verdict]));
  assert.deepEqual(verdicts, { Concrete: 'ranked', Velvet: 'known', 'Neon Haze': 'unknown', Portishead: 'ranked', 'Thom Yorke': 'known', 'Imaginary Lamps': 'unknown' });
  assert.deepEqual(final.baseline.counts, { ranked: 2, known: 2, unknown: 2 });
  assert.equal(JSON.stringify(ev).includes(OKEY) || JSON.stringify(ev).includes(QKEY), false, 'no key reaches the browser');
});

test('roomful: a painting becomes a 3D room through MoGe-2, streamed back through the server, key never exposed', async t => {
  const FKEY = 'fal-secret-key', calls = [];
  const fetcher = async (url, options = {}) => {
    url = new URL(url); calls.push({ host: url.host, auth: options.headers?.authorization });
    if (url.host === 'fal.run' && url.pathname === '/fal-ai/luma-photon/flash/reframe') {
      const body = JSON.parse(options.body);
      assert.equal(body.aspect_ratio, '21:9'); assert.match(body.image_url, /^data:image\/jpeg;base64,/);
      return Response.json({ images: [{ url: 'https://v3b.fal.media/files/wide.jpg' }] });
    }
    if (url.host === 'fal.run') {
      assert.equal(url.pathname, '/fal-ai/moge-2');
      assert.match(JSON.parse(options.body).image_url, /^data:image\/jpeg;base64,/);
      return Response.json({ model_mesh: { url: 'https://v3b.fal.media/files/room.glb' }, fov_x: 49 });
    }
    if (url.host === 'v3b.fal.media') return new Response(new Uint8Array([103, 108, 84, 70]));
    throw new Error(`unexpected ${url}`);
  };
  const base = await serve(t, { SITE: 'room', FAL_KEY: FKEY }, fetcher);
  assert.equal((await (await fetch(`${base}/api/config`)).json()).room3d, true);
  // Widen: a site image is sent inline; anything that isn't this site's or fal's is refused.
  const wide = await (await fetch(`${base}/api/room3d/widen`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ painting: '/img/demo-room-rain-1.jpg' }) })).json();
  assert.equal(wide.image, 'https://v3b.fal.media/files/wide.jpg');
  const foreign = await fetch(`${base}/api/room3d/widen`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ painting: 'https://example.com/x.jpg' }) });
  assert.equal(foreign.status, 404);
  const bad = await fetch(`${base}/api/room3d`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ image: 'https://example.com/x.jpg' }) });
  assert.equal(bad.status, 400);
  const res = await fetch(`${base}/api/room3d`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ image: 'data:image/jpeg;base64,/9j/AAAA' }) });
  const data = await res.json();
  assert.equal(res.status, 200); assert.match(data.glb, /^\/api\/room3d\/mesh\?u=/);
  assert.ok(!JSON.stringify(data).includes(FKEY));
  // The mesh proxy only ever fetches fal's media host.
  assert.equal((await fetch(`${base}/api/room3d/mesh?u=${encodeURIComponent('https://evil.example/x.glb')}`)).status, 404);
  const glb = await fetch(base + data.glb);
  assert.equal(glb.headers.get('content-type'), 'model/gltf-binary');
  assert.equal(Buffer.from(await glb.arrayBuffer()).toString(), 'glTF');
  assert.equal(calls.find(c => c.host === 'fal.run').auth, `Key ${FKEY}`);
});
