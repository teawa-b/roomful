import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createQloo, qlooHosts } from './lib/qloo.js';
import { chooseLlm } from './lib/llm.js';
import { chooseImageModel } from './lib/images.js';
import { createLimiter } from './lib/limits.js';
import { createLive } from './lib/live.js';
import { createDepth3d } from './lib/depth3d.js';
import { buildRoom } from './lib/room.js';
import { loadDemo, listDemos, replay, demoRender } from './lib/demos.js';

// Roomful's backend: serves the pages in ../frontend and the API that builds a room from your favourites, plays it and opens it in 3D.
const files = {
  '/': ['room.html', 'text/html'], '/room.js': ['room.js', 'text/javascript'], '/room.css': ['room.css', 'text/css'],
  '/room3d': ['room3d.html', 'text/html'], '/room3d.js': ['room3d.js', 'text/javascript'],
  '/live': ['live.html', 'text/html'], '/live.js': ['live.js', 'text/javascript'],
  '/style.css': ['style.css', 'text/css'], '/favicon.svg': ['favicon.svg', 'image/svg+xml'],
  '/sound.js': ['sound.js', 'text/javascript']
};
const cdn = 'https://cdn.jsdelivr.net';

const csp = {
  // Roomful plays its playlist through YouTube's search embed; its 3D room loads three.js from jsDelivr.
  home: `default-src 'self'; img-src 'self' https: data: blob:; style-src 'self' ${cdn} https://fonts.googleapis.com; font-src https://fonts.gstatic.com ${cdn}; script-src 'self' ${cdn}; frame-src https://www.youtube.com https://www.youtube-nocookie.com; connect-src 'self' blob: ${cdn}; base-uri 'none'; frame-ancestors 'none'`,
  // The live walkthrough plays a WebRTC stream; media flows peer-to-peer, signalling goes through this server.
  live: "default-src 'self'; img-src 'self' https: data: blob:; media-src 'self' blob:; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'"
};

// Bounded in-memory stores. A single instance is enough for a demo; restarts clear them.
function boundedMap(limit) {
  const map = new Map();
  return { get: k => map.get(k), set(k, v) { map.set(k, v); while (map.size > limit) map.delete(map.keys().next().value); return v; }, has: k => map.has(k), values: () => [...map.values()] };
}

export function createApp({ env = process.env, fetcher = fetch } = {}) {
  const renders = boundedMap(300), videos = new Map();
  const llm = chooseLlm(env, fetcher), imageModel = chooseImageModel(env, fetcher);
  const depth3d = env.FAL_KEY ? createDepth3d({ key: env.FAL_KEY, fetcher }) : null;
  const live = env.FAL_KEY ? createLive({ key: env.FAL_KEY, model: env.FAL_WORLD_MODEL || undefined, maxSeconds: Number(env.LIVE_MAX_SECONDS || 180), fetcher }) : null;
  const qlooHost = qlooHosts.includes(env.QLOO_API_HOST) ? env.QLOO_API_HOST : qlooHosts[0];
  const limit = createLimiter({
    agent: [Number(env.AGENT_RUNS_PER_HOUR || 5), 3600e3],
    agentIpDaily: [Number(env.AGENT_RUNS_PER_IP_PER_DAY || 12), 86400e3],
    refine: [Number(env.REFINES_PER_HOUR || 8), 3600e3],
    geocode: [120, 3600e3],
    agentDaily: [Number(env.AGENT_RUNS_PER_DAY || 200), 86400e3, true],
    live: [Number(env.LIVE_SESSIONS_PER_HOUR || 2), 3600e3],
    liveIpDaily: [Number(env.LIVE_SESSIONS_PER_IP_PER_DAY || 3), 86400e3],
    liveDaily: [Number(env.LIVE_SESSIONS_PER_DAY || 20), 86400e3, true],
    room3d: [Number(env.ROOMS_3D_PER_HOUR || 20), 3600e3],
    room3dDaily: [Number(env.ROOMS_3D_PER_DAY || 300), 86400e3, true]
  });

  async function saveRender(result) {
    const id = randomUUID();
    const render = { id, url: result.url || `/api/render/${id}`, model: result.model, prompt: result.prompt, aspect: result.aspect, signals: result.signals, listingId: result.listingId, parent: result.parent };
    renders.set(id, { ...render, remoteUrl: result.url, bytes: result.bytes, type: result.type });
    return render;
  }
  const renderImage = r => r.remoteUrl ? { url: r.remoteUrl } : { bytes: r.bytes, type: r.type };
  // A render made on this instance, or one from a recorded example (any instance can serve those).
  const getRender = async id => renders.get(String(id || '')) || (await demoRender(id).then(r => r && renders.set(r.id, { ...r })));

  return async function handle(req, res) {
    const send = (status, value, headers = {}) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers }); res.end(JSON.stringify(value)); };
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    // Who is asking, for the limits. Behind a proxy (Railway) the real address is the one the proxy adds: X-Real-IP,
    // or the last X-Forwarded-For entry. The first entry is whatever the visitor sent, so it can't be trusted.
    const ip = String(req.headers['x-real-ip'] || String(req.headers['x-forwarded-for'] || '').split(',').pop() || req.socket.remoteAddress || '').trim();
    try {
      const url = new URL(req.url, 'http://localhost');
      const path = url.pathname;
      // Static images and 3D rooms shipped with the app (logos, the examples). Names are restricted, so no path tricks.
      const image = path.match(/^\/img\/([a-z0-9-]+)\.(jpg|png|webp|glb)$/);
      if (req.method === 'GET' && image) {
        const bytes = await readFile(new URL(`../frontend/img/${image[1]}.${image[2]}`, import.meta.url)).catch(() => null);
        if (!bytes) return send(404, { error: 'Not found' });
        res.writeHead(200, { 'Content-Type': image[2] === 'glb' ? 'model/gltf-binary' : `image/${image[2] === 'jpg' ? 'jpeg' : image[2]}`, 'Cache-Control': 'public, max-age=86400' });
        return res.end(bytes);
      }
      const entry = files[path];
      if (req.method === 'GET' && entry) {
        const [name, type] = entry;
        res.setHeader('Content-Security-Policy', csp[path.startsWith('/live') ? 'live' : 'home'] || csp.home);
        res.writeHead(200, { 'Content-Type': `${type}; charset=utf-8`, 'Cache-Control': 'no-cache' });
        return res.end(await readFile(new URL(`../frontend/${name}`, import.meta.url)));
      }
      if (req.method === 'GET' && path === '/api/health') return send(200, { ok: true });
      if (req.method === 'GET' && path === '/api/demos') return send(200, { demos: await listDemos('room') });
      if (req.method === 'GET' && path === '/api/config') {
        return send(200, { site: 'room', siteName: 'Roomful', qloo: Boolean(env.QLOO_API_KEY), qlooHost, llm: llm?.label || null, image: imageModel?.label || null, liveWorld: live ? { model: live.model, maxSeconds: live.maxSeconds } : null, room3d: Boolean(depth3d) });
      }
      // Roomful's player: the first YouTube result for an artist, found without an API key (the
      // results page lists video ids inline). Cached per query; the browser then embeds that one video.
      if (req.method === 'GET' && path === '/api/yt') {
        const q = (url.searchParams.get('q') || '').trim().slice(0, 80);
        if (!q) return send(400, { error: 'Name an artist.' });
        if (!videos.has(q)) {
          if (!limit.take('geocode', ip)) return send(429, { error: 'Too many lookups. Slow down a little.' });
          videos.set(q, (async () => {
            const page = await fetcher(`https://www.youtube.com/results?search_query=${encodeURIComponent(q)}`, { headers: { 'user-agent': 'Mozilla/5.0 (Roomful)', 'accept-language': 'en' }, signal: AbortSignal.timeout(10000) });
            const ids = [...(await page.text()).matchAll(/"videoId":"([A-Za-z0-9_-]{11})"/g)].map(m => m[1]);
            const id = ids.find((v, i) => ids.indexOf(v) === i);
            if (!id) throw Object.assign(new Error('No video found.'), { status: 404 });
            return id;
          })().catch(error => { videos.delete(q); throw error; }));
        }
        return send(200, { id: await videos.get(q) });
      }
      let match = path.match(/^\/api\/render\/([\w-]+)$/);
      if (req.method === 'GET' && match) {
        const render = await getRender(match[1]);
        if (!render) return send(404, { error: 'This render has expired.' });
        if (render.remoteUrl) { res.writeHead(302, { Location: render.remoteUrl }); return res.end(); }
        res.writeHead(200, { 'Content-Type': render.type, 'Cache-Control': 'private, max-age=3600' });
        return res.end(render.bytes);
      }
      // A room's 3D mesh, streamed from fal (see lib/depth3d.js). The link carries the fal file itself, so any
      // server instance can answer it; only fal's own media host is ever fetched.
      if (req.method === 'GET' && path === '/api/room3d/mesh') {
        const src = url.searchParams.get('u') || '';
        if (!depth3d || !/^https:\/\/[\w.-]+\.fal\.media\/[\w./-]+\.glb$/.test(src)) return send(404, { error: 'Not found' });
        const upstream = await depth3d.open(src);
        res.writeHead(200, { 'Content-Type': 'model/gltf-binary', 'Cache-Control': 'public, max-age=86400' });
        for await (const chunk of upstream.body) res.write(chunk);
        return res.end();
      }

      if (req.method !== 'POST') return send(404, { error: 'Not found' });
      const origin = req.headers.origin;
      if (origin) { let host; try { host = new URL(origin).host; } catch {} if (host !== req.headers.host) return send(403, { error: 'Requests must come from this app.' }); }

      // A painting sent for the 3D room needs more room than the JSON endpoints.
      const body = await readBody(req, path === '/api/room3d' ? 600_000 : 32_000);

      // Instant demos: replay a recorded real run (no live calls, no run limit). See lib/demos.js.
      const demoSite = { '/api/room': 'room' }[path];
      if (demoSite && body.demo) {
        const demo = await loadDemo(demoSite, body.demo);
        if (!demo) return send(404, { error: 'That example is not available.' });
        // Re-register the recorded renders so refine, relight and the live walkthrough work from a replay.
        for (const r of demo.renders || []) if (!renders.has(r.id)) renders.set(r.id, { ...r, url: r.url, remoteUrl: r.remoteUrl });
        res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
        const emit = event => { if (!res.writableEnded) res.write(`data: ${JSON.stringify(event)}\n\n`); };
        // An optional slower pace (ms per step, capped) lets the explainer videos film the steps arriving.
        try { await replay(demo, emit, { step: Math.min(1500, Math.max(140, Number(body.pace) || 140)) }); } finally { res.end(); }
        return;
      }

      // Roomful: favourites → Qloo taste → a painted room, streamed step by step.
      if (path === '/api/room') {
        const text = String(body.text || '').trim().slice(0, 600);
        if (!text) return send(400, { error: 'Name a few things you love.' });
        if (!env.QLOO_API_KEY) return send(503, { error: 'This server has no Qloo API key configured.' });
        if (!limit.take('agent', ip) || !limit.take('agentIpDaily', ip) || !limit.take('agentDaily', 'all')) return send(429, { error: 'Run limit reached. Try again in a while.' });
        res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
        const emit = event => { if (!res.writableEnded) res.write(`data: ${JSON.stringify(event)}\n\n`); };
        const heartbeat = setInterval(() => !res.writableEnded && res.write(': ping\n\n'), 15000);
        const qloo = createQloo({ key: env.QLOO_API_KEY, host: qlooHost, fetcher });
        try { await buildRoom({ qloo, llm, imageModel, text, emit, saveRender }); }
        catch (error) { emit({ type: 'error', message: error.message }); }
        finally { clearInterval(heartbeat); emit({ type: 'done', qlooCalls: qloo.calls }); res.end(); }
        return;
      }

      if (path === '/api/refine') {
        const render = await getRender(body.renderId);
        const instruction = String(body.instruction || '').trim().slice(0, 400);
        if (!render) return send(404, { error: 'That render has expired. Run the agent again.' });
        if (!instruction) return send(400, { error: 'Describe the change.' });
        if (!imageModel) return send(503, { error: 'No image model is configured.' });
        if (!limit.take('refine', ip)) return send(429, { error: 'Change limit reached. Try again later.' });
        const prompt = `${instruction} Keep everything else in the photo identical: every wall, window, door, piece of furniture, material and the camera angle and framing.`;
        // Quick lighting tweaks (time of day) use the fast path; free-form changes use full quality.
        const result = await imageModel.edit({ image: renderImage(render), prompt, aspect: render.aspect, fast: body.fast === true });
        return send(200, { render: await saveRender({ ...result, prompt: instruction, aspect: render.aspect, listingId: render.listingId, signals: render.signals, parent: render.id }) });
      }

      if (path.startsWith('/api/live/')) {
        if (!live) return send(503, { error: 'Live walkthroughs need a fal key on the server.' });
        const liveId = String(body.liveId || '');
        if (path === '/api/live/start') {
          const image = /^https:\/\/[\w.-]+\.fal\.media\/[\w./-]+$/.test(String(body.image || '')) ? body.image : null;
          const render = (await getRender(body.renderId)) || (image && { remoteUrl: image, prompt: '' });
          if (!render?.remoteUrl) return send(404, { error: 'That render has expired. Run the agent again.' });
          if (!limit.take('live', ip) || !limit.take('liveIpDaily', ip) || !limit.take('liveDaily', 'all')) return send(429, { error: 'Live walkthrough limit reached. Try again later.' });
          const concept = body.concept && typeof body.concept === 'object' ? { name: String(body.concept.name || '').slice(0, 80), tagline: String(body.concept.tagline || '').slice(0, 160) } : {};
          const world = { url: render.remoteUrl, prompt: `Walking through ${concept.name || 'a redesigned venue'}, a newly renovated interior. ${String(render.prompt || '').split('\n')[0].slice(0, 900)}`, concept };
          return send(200, { ...(await live.start(world)), world });
        }
        if (path === '/api/live/session') return send(200, await live.session(liveId, body.sdp, body.type));
        if (path === '/api/live/heartbeat') return send(200, await live.heartbeat(liveId));
        if (path === '/api/live/end') { live.end(liveId); return send(200, { ok: true }); }
        return send(404, { error: 'Not found' });
      }

      // A painting widened to 21:9 first, so its 3D room has more to walk into. The painting is one of this site's
      // images, a render made here, or a fal image.
      if (path === '/api/room3d/widen') {
        if (!depth3d) return send(503, { error: '3D rooms need a fal key on the server.' });
        const src = String(body.painting || '');
        let image = null;
        const local = src.match(/^\/img\/([a-z0-9-]+)\.(jpg|png)$/), made = src.match(/^\/api\/render\/([\w-]+)$/);
        if (local) { const bytes = await readFile(new URL(`../frontend/img/${local[1]}.${local[2]}`, import.meta.url)).catch(() => null); if (bytes) image = `data:image/${local[2] === 'jpg' ? 'jpeg' : 'png'};base64,${bytes.toString('base64')}`; }
        else if (made) { const r = await getRender(made[1]); image = r?.remoteUrl || (r?.bytes ? `data:${r.type};base64,${Buffer.from(r.bytes).toString('base64')}` : null); }
        else if (/^https:\/\/[\w.-]+\.fal\.media\/[\w./-]+$/.test(src)) image = src;
        if (!image) return send(404, { error: 'That painting has expired. Build the room again.' });
        if (!limit.take('room3d', ip) || !limit.take('room3dDaily', 'all')) return send(429, { error: '3D room limit reached. Try again later.' });
        return send(200, { image: await depth3d.widen(image) });
      }

      if (path === '/api/room3d') {
        if (!depth3d) return send(503, { error: '3D rooms need a fal key on the server.' });
        if (!limit.take('room3d', ip) || !limit.take('room3dDaily', 'all')) return send(429, { error: '3D room limit reached. Try again later.' });
        const room = await depth3d.build(body.image);
        return send(200, { glb: `/api/room3d/mesh?${new URLSearchParams({ u: room.url })}`, fovX: room.fovX });
      }

      return send(404, { error: 'Not found' });
    } catch (error) {
      if (res.headersSent) { try { res.end(); } catch {} return; }
      send(error.status && error.status < 600 ? error.status : 400, { error: error.message, ...(error.details ? { details: error.details } : {}) });
    }
  };
}

async function readBody(req, max) {
  let raw = '';
  for await (const chunk of req) { raw += chunk; if (raw.length > max) throw Object.assign(new Error('Request too large.'), { status: 413 }); }
  try { const body = JSON.parse(raw); if (body && typeof body === 'object') return body; } catch {}
  throw Object.assign(new Error('Invalid JSON.'), { status: 400 });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 3301);
  const host = process.env.HOST || (process.env.PORT ? '0.0.0.0' : '127.0.0.1');
  http.createServer(createApp()).listen(port, host, () => console.log(`Roomful running at http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`));
}
