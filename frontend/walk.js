// Step inside a painted room as a World Labs Marble world: Gaussian splats drawn with Spark, walked with WASD
// (drag or arrow keys to look), on-screen buttons on a phone, or a headset (Enter VR).
// ?render=<id>&name=<room> starts the world (the server keeps one per render); the page then swaps to ?id=<world>,
// so a reload or a shared link picks up the same world instead of building another.
import * as THREE from 'three';
import { SparkRenderer, SplatMesh } from '@sparkjsdev/spark';
import { startMusic } from '/music.js';
startMusic();

const $ = id => document.getElementById(id);
const params = new URLSearchParams(location.search);
let worldId = params.get('id');
const name = params.get('name') || '';
$('w3-name').textContent = name;
const api = async (path, body) => {
  const res = await fetch(path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : undefined);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status}).`);
  return data;
};

const renderer = new THREE.WebGLRenderer({ antialias: false });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.xr.enabled = true;
renderer.domElement.id = 'view';
document.body.prepend(renderer.domElement);
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x1d1218);
const camera = new THREE.PerspectiveCamera(70, 1, 0.05, 200);
// The rig is what walks; the camera turns inside it (and, in VR, the headset moves it).
const rig = new THREE.Group(); rig.add(camera); scene.add(rig);
scene.add(new SparkRenderer({ renderer, sortRadial: true, enableLod: true, maxPixelRadius: 512 }));
const resize = () => { renderer.setSize(innerWidth, innerHeight, false); camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); };
addEventListener('resize', resize); resize();

// Keys: walking and looking; the matching on-screen key lights up.
const held = new Set();
const key = (k, on) => { const el = document.querySelector(`[data-k="${k}"]`); if (el) el.classList.toggle('on', on); on ? held.add(k) : held.delete(k); };
addEventListener('keydown', e => { const k = e.key.toLowerCase(); if (['w', 'a', 's', 'd', 'q', 'e', 'arrowleft', 'arrowright', 'arrowup', 'arrowdown'].includes(k)) { e.preventDefault(); key(k, true); } });
addEventListener('keyup', e => key(e.key.toLowerCase(), false));
let yaw = 0, pitch = 0, drag = null;
const canvas = renderer.domElement;
canvas.addEventListener('pointerdown', e => { drag = [e.clientX, e.clientY]; canvas.setPointerCapture(e.pointerId); });
canvas.addEventListener('pointermove', e => { if (!drag) return; yaw -= (e.clientX - drag[0]) * 0.004; pitch -= (e.clientY - drag[1]) * 0.004; drag = [e.clientX, e.clientY]; });
canvas.addEventListener('pointerup', () => { drag = null; });
// Phone buttons: hold to walk or turn.
const pad = new Set();
document.querySelectorAll('.w3-pad button').forEach(b => {
  const on = () => pad.add(b), off = () => pad.delete(b);
  b.addEventListener('pointerdown', on); b.addEventListener('pointerup', off); b.addEventListener('pointerleave', off); b.addEventListener('pointercancel', off);
});

// An unhurried pace: this is a place to slow down in, not to run through.
const SPEED = 1.1, TURN = 1.1, LIMIT = 8;
const clock = new THREE.Clock(), fwd = new THREE.Vector3(), side = new THREE.Vector3(), move = new THREE.Vector3();
renderer.setAnimationLoop(() => {
  const dt = Math.min(clock.getDelta(), 0.1);
  move.set(0, 0, 0);
  if (!renderer.xr.isPresenting) {
    if (held.has('arrowleft')) yaw += TURN * dt; if (held.has('arrowright')) yaw -= TURN * dt;
    if (held.has('arrowup')) pitch += TURN * dt; if (held.has('arrowdown')) pitch -= TURN * dt;
    for (const b of pad) { if (b.dataset.turn) yaw += Number(b.dataset.turn) * TURN * dt; if (b.dataset.move === 'f') move.z -= 1; if (b.dataset.move === 'b') move.z += 1; }
    pitch = Math.max(-1.2, Math.min(1.2, pitch));
    camera.rotation.set(pitch, yaw, 0, 'YXZ');
    if (held.has('w')) move.z -= 1; if (held.has('s')) move.z += 1; if (held.has('a')) move.x -= 1; if (held.has('d')) move.x += 1;
    if (held.has('q')) rig.position.y -= SPEED * dt; if (held.has('e')) rig.position.y += SPEED * dt;
    fwd.set(-Math.sin(yaw), 0, -Math.cos(yaw)); side.set(-fwd.z, 0, fwd.x);
    if (move.lengthSq()) rig.position.addScaledVector(fwd, -move.z * SPEED * dt).addScaledVector(side, move.x * SPEED * dt);
  } else {
    // Thumbsticks: the left one walks where you look, the right one turns.
    for (const source of renderer.xr.getSession()?.inputSources || []) {
      const axes = source.gamepad?.axes; if (!axes || axes.length < 4) continue;
      if (source.handedness === 'right') rig.rotation.y -= axes[2] * 1.5 * dt;
      else {
        camera.getWorldDirection(fwd); fwd.y = 0; fwd.normalize(); side.set(-fwd.z, 0, fwd.x);
        rig.position.addScaledVector(fwd, -axes[3] * SPEED * dt).addScaledVector(side, axes[2] * SPEED * dt);
      }
    }
  }
  rig.position.x = THREE.MathUtils.clamp(rig.position.x, -LIMIT, LIMIT);
  rig.position.z = THREE.MathUtils.clamp(rig.position.z, -LIMIT, LIMIT);
  renderer.render(scene, camera);
});

const status = text => { $('w3-status').textContent = text; };
const fail = message => {
  status(message); $('w3-sub').hidden = true; document.querySelector('.w3-bar').hidden = true;
  $('w3-retry').hidden = false; $('w3-retry').onclick = () => location.reload();
};
async function load() {
  if (!worldId) {
    const renderId = params.get('render');
    if (!renderId) return fail('No room to step into yet.');
    ({ worldId } = await api('/api/world', { renderId, name }));
    const keep = Object.fromEntries(['music', 'at', 'yt'].filter(k => params.has(k)).map(k => [k, params.get(k)]));
    history.replaceState(null, '', `/walk?${new URLSearchParams({ id: worldId, name, ...keep })}`);
  }
  const world = await api(`/api/world/${encodeURIComponent(worldId)}`);
  if (!world.done) {
    // World Labs reports progress as a percentage; until it does, creep forward so the page never looks stuck.
    const bar = $('w3-progress'), now = parseFloat(bar.style.width) || 4;
    bar.style.width = `${Math.max(now, Math.min(95, world.progress ?? now + 2))}%`;
    status(world.progress != null ? `Building your world, ${Math.round(world.progress)}%` : 'Building your world');
    return setTimeout(() => load().catch(error => fail(error.message)), 6000);
  }
  if (world.error) return fail(`This world could not be built: ${world.error}`);
  status('Opening the world…'); $('w3-sub').hidden = true; $('w3-progress').style.width = '100%';
  const mobile = matchMedia('(pointer: coarse)').matches, want = mobile ? '100k' : '500k';
  const res = world.assets.splat.includes(want) ? want : world.assets.splat[0];
  if (!res) return fail('This world has nothing to show.');
  const splat = new SplatMesh({ url: `/api/world/${encodeURIComponent(worldId)}/asset?res=${res}` });
  // World Labs splats use an inverted Y axis relative to three.js.
  splat.quaternion.set(1, 0, 0, 0);
  scene.add(splat);
  await splat.initialized;
  $('w3-load').hidden = true;
  if (world.marbleUrl) { const a = Object.assign(document.createElement('a'), { href: world.marbleUrl, target: '_blank', rel: 'noreferrer', textContent: 'Open in Marble' }); $('w3-note').append(' ', a); }
}
load().catch(error => fail(error.message));

// Headsets: an immersive session puts you in the room.
if (navigator.xr && await navigator.xr.isSessionSupported('immersive-vr').catch(() => false)) {
  $('w3-vr').hidden = false;
  $('w3-vr').addEventListener('click', async () => {
    const session = await navigator.xr.requestSession('immersive-vr', { optionalFeatures: ['local-floor'] });
    renderer.xr.setReferenceSpaceType('local');
    await renderer.xr.setSession(session);
  });
}
