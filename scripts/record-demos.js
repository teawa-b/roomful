// Records instant examples: runs each taste through a live Roomful (with its keys), saves the painting into
// frontend/img and the exact event stream into backend/data/demos, so the example replays with no keys at all.
//   node scripts/record-demos.js https://roomful-ten.vercel.app slug="Favourite, Favourite, …" [slug="…"]
import { writeFile } from 'node:fs/promises';

const [base, ...pairs] = process.argv.slice(2);
if (!base || !pairs.length) { console.error('Usage: node scripts/record-demos.js <base url> slug="a, b, c" …'); process.exit(1); }
const root = new URL('../', import.meta.url);

for (const pair of pairs) {
  const [, slug, text] = pair.match(/^([a-z0-9-]{1,40})=(.+)$/) || [];
  if (!slug) { console.error(`Skipping ${pair}: use slug="favourites"`); continue; }
  console.log(`\n${slug}: ${text}`);
  const res = await fetch(new URL('/api/room', base), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }) });
  if (!res.ok) { console.error(`  failed: ${res.status} ${await res.text()}`); continue; }
  const events = [];
  let buffer = '';
  for await (const chunk of res.body.pipeThrough(new TextDecoderStream())) {
    buffer += chunk;
    let i;
    while ((i = buffer.indexOf('\n\n')) >= 0) {
      const line = buffer.slice(0, i).split('\n').find(l => l.startsWith('data: ')); buffer = buffer.slice(i + 2);
      if (!line) continue;
      const ev = JSON.parse(line.slice(6)); events.push(ev);
      if (ev.type === 'step_done') console.log(`  ✓ ${ev.id}: ${ev.summary || ''}`);
      if (ev.type === 'step_error' || ev.type === 'error') console.log(`  ✗ ${ev.id || ''} ${ev.message}`);
    }
  }
  const final = events.find(e => e.type === 'final');
  if (!final?.render?.url) { console.error('  no painting, not saved'); continue; }
  const remoteUrl = new URL(final.render.url, base).href;
  const img = await fetch(remoteUrl);
  if (!img.ok) { console.error(`  painting download failed: ${img.status}`); continue; }
  const file = `demo-room-${slug}-1.jpg`;
  await writeFile(new URL(`frontend/img/${file}`, root), Buffer.from(await img.arrayBuffer()));
  final.render = { ...final.render, url: `/img/${file}` };
  const demo = { site: 'room', slug, title: final.concept.name, request: { text }, events, renders: [{ ...final.render, remoteUrl }], baseline: final.baseline || null, recorded: new Date().toISOString() };
  await writeFile(new URL(`backend/data/demos/room-${slug}.json`, root), JSON.stringify(demo, null, 1));
  console.log(`  saved "${final.concept.name}" → frontend/img/${file}`);
}
