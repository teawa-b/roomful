# Roomful

<img src="frontend/img/roomful-180.png" width="64" alt="Roomful logo">

**Name a few things you love. Walk into the room they make, with the music on.**

![Roomful home](docs/roomful-home.png)

**Try it:** https://roomful-ten.vercel.app · **Video:** https://youtu.be/VUXtNE295lY

## Judge in 60 seconds

1. Open the site and click the **Quiet Signal Room** example. It is a recorded real run, so it opens in seconds.
2. Look at the room: the painting, the name, and the first track playing from the room's Qloo playlist.
3. Scroll to **Every choice, and the taste behind it**: each design choice names the Qloo result behind it. Anything Qloo did not return is marked unverified.
4. Read **With and without Qloo**: the same favourites given to an LLM alone, each of its picks checked against Qloo.
5. Click **Walk inside in 3D**. Roomful paints the room out to 21:9 (Luma Photon Reframe on fal), then lifts it into 3D (MoGe-2 on fal). Walk in with W, A, S and D, look with the arrow keys or by dragging, or press Enter VR on a headset. Every room gets one, in about 30 seconds, for about 2 cents.

## Try it in 10 seconds

| Example | Favourites | Link |
|---|---|---|
| Quiet Signal Room | Radiohead, Blade Runner, Haruki Murakami, Muji | `/?demo=rain` |
| Velvet Speakeasy Lounge | Phoebe Bridgers, Fleabag, Sally Rooney, Glossier, Dr. Martens | `/?demo=heartbreak` |
| Art Deco Court | Kendrick Lamar, Nike, Jordan Peele films, Issa Rae, Lakers | `/?demo=courtside` |

![A finished room: the painting, the playlist and the reasons](docs/roomful-result.png)

## Where Qloo comes in

```
your favourites ──► Qloo /search ──► entities
                                       │  signal.interests.entities
                                       ▼
            Qloo /v2/insights: the rooms (decor, ambience tags), the playlist,
            the shelf and the screen (artists, books, films, brands), the crowd's ages
                                       │
                                       ▼
            an LLM writes the room from those names only ──► the painting ──► walk inside
```

| Step | Qloo call |
|---|---|
| Find your favourites | `GET /search?query=…` (a hit only counts if it shares a real word with what you typed); `/v2/tags` as a fallback |
| Rooms people with your taste rate | `GET /v2/insights?filter.type=urn:tag&filter.parents.types=urn:entity:place&filter.tag.types=urn:tag:decor:qloo` (and `ambience`, `interests`) with `signal.interests.entities=<favourites>` |
| The playlist, shelf and screen | `GET /v2/insights?filter.type=urn:entity:artist` (and `book`, `movie`, `brand`) with the same signal |
| Who shares the taste | `GET /v2/insights?filter.type=urn:demographics&signal.interests.entities=<favourites>` |

## With and without Qloo

After the room is written, the same favourites go to an LLM with no tools, and each of its 8 picks (3 decor or mood words, 3 artists, 2 brands) is checked against what Qloo returned for that taste:

| Example | Picks that hold up without Qloo |
|---|---|
| Quiet Signal Room | 0 of 8 |
| Velvet Speakeasy Lounge | 3 of 8 |
| Art Deco Court | 2 of 8 |

The LLM's picks are often real (Vangelis, Brian Eno, an Eames chair) but not what people with this taste actually rate, and some are not in Qloo at all ("Rain-Streaked Glass").

## How the code is laid out

```
frontend/      what the browser loads: plain HTML, CSS and JavaScript, plus the images. No build step.
backend/
  server.js    a Node 22 HTTP server with no framework. It serves frontend/ and the API, and holds every key.
  lib/         where the work happens:
    room.js       the whole pipeline: favourites to Qloo to a written room to a painting, plus the with-and-without-Qloo check
    interests.js  splits "Radiohead, Blade Runner and Muji" into separate favourites
    qloo.js       a small Qloo client that logs every call for the page
    images.js     paints the room on fal (or OpenAI)
    depth3d.js    widens the painting with Luma Reframe and lifts it into 3D with MoGe-2
    live.js       fal's real-time world model, for the live walk
    llm.js        the OpenRouter client
    demos.js      replays the recorded rooms in backend/data/demos
    limits.js     per-visitor and daily limits on everything that costs money
    http.js       fetch with timeouts, and key redaction in error messages
  data/        the recorded example runs
test/          node --test, against fake Qloo, LLM and image services, so no keys are needed
api/           the Vercel entry point: one function that hands every request to backend/server.js
```

The pages in `frontend/`:

- `room.html, room.js, room.css`: the home page, the room and its playlist
- `room3d.html, room3d.js`: the room in 3D, with WASD or a VR headset
- `live.html, live.js`: the live walk

The browser only ever talks to this server. Qloo, the model and the image services are called from `backend/`, so no key reaches the page, and anything that costs money has a per-visitor limit (`backend/lib/limits.js`).

## Run it yourself

There are no dependencies to install. With Node 22 or newer:

```bash
npm start
```

Then open http://localhost:3301. The recorded examples work with no keys at all. For live runs, put these in a `.env` file next to `package.json`:

- `QLOO_API_KEY`: Qloo, for the taste behind the room
- `OPENROUTER_API_KEY`: writes the room from what Qloo returned (Claude Haiku 5.5 by default; `LLM_MODEL` changes it)
- `FAL_KEY`: paints the room (GPT Image 2.5 Flare) and builds the 3D walk (Luma Reframe and MoGe-2)

```bash
npm test
```

## Deploy

`vercel.json` sends every request to `api/index.js`, so `vercel deploy` is enough. Add the same keys as environment variables in the project settings. Any host that runs Node works too: `npm start` listens on `PORT` when it is set.

## Tests

```
✔ roomful: favourites become Qloo taste, the brief cites it, and an LLM alone is checked against it
✔ recorded examples replay without any API keys, and the pages load
```

[`test/room.test.js`](test/room.test.js) runs against a fake Qloo and a fake LLM. It checks that the favourites become the Qloo signal, that an invented name in the brief is flagged, that the "without Qloo" picks get the right verdicts (ranked, real but not ranked, not in Qloo), and that no key reaches the browser.

## Known limitations

- The painting is a generated image of a room that doesn't exist; the walkthrough improvises beyond it.
- The 3D room is the painting with depth, seen from the front: you can step about a metre into it and look around a little, not turn all the way round. Furniture edges stretch when you move far sideways.
- Favourites Qloo doesn't know (or only knows as something else) are skipped rather than guessed.
- Music plays through YouTube embeds, found on the server without an API key; a track can occasionally be unavailable.

The pipeline lives in [`backend/lib/room.js`](backend/lib/room.js).

## License

MIT. Built for the Qloo Agentic Hackathon, October 2026.
