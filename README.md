# Steam News Dedupe (Millennium plugin)

Publishers often copy the same news post into every game in a franchise
("WB Games Autumn Sale is here", "Last Chance to buy your favorite DC Games…").
This plugin keeps only the first copy in the **Steam News Hub** (Store → News)
and hides the rest.

The post that's kept gets a small **"+N duplicates"** pill in its top-right corner.
Hover over it to see which games also got the post, or click it to show or hide the copies.

## Install

Prerequisites: [Millennium](https://steambrew.app) ≥ 3.4 and [Bun](https://bun.com).

```powershell
# Windows: install Bun once, if you don't have it
powershell -c "irm bun.sh/install.ps1 | iex"
```

```bash
cd steam-news-dedupe
bun install
bun run build
```

`bun run build` packs the plugin and installs it straight into Millennium
(`output_path = "auto"` in `millennium.toml`). Restart Steam, then open
**Millennium → Plugins**, enable **Steam News Dedupe**, and reload Steam's UI when it asks.

## Settings (Millennium → Plugins → Steam News Dedupe)

| Setting | Default | What it does |
|---|---|---|
| Hide duplicate news posts | on | Master switch. |
| Aggressive matching (title only) | off | Merge *any* posts that share a title. When this is off, posts must share a title **and** either have the same body text (links and images are ignored) or be posted within 3 days of each other. |
| Show "+N duplicates" badge | on | Show the pill on the post that's kept. |

## How it works

* `webview/preload.ts` is injected by Millennium into Steam's web views. It only runs on
  `store.steampowered.com/news/*` (the News Hub, both in the Steam client and in its store browser).
* `webview/dedupe.ts` reads the event data the hub already loads (`/events/ajaxgetusereventcalendarrange`,
  `/events/ajaxgeteventdetails`, …). It finds those requests through the Performance API, so it never patches the page's own
  `fetch`/XHR. Then it groups feed cards whose posts match and hides every card after the first.
* The post you have open (`?emgid=…` or a direct `/view/<id>` link) is never hidden, and nothing inside the post viewer popup is touched.
* `frontend/index.tsx` holds the settings panel. The settings are stored with Millennium's plugin config,
  which the webview script also reads, and changes apply live.

Debugging: in the News Hub's devtools console, `window.__newsDedupe` shows the parsed events and settings.

## Limitations

* This only covers the News Hub. The "What's New" shelf on the Library home page is a separate part of
  Steam's own UI and isn't de-duplicated yet.
* Even with aggressive matching off, two different posts that share the exact same title (20+ characters)
  and go up within 3 days of each other are merged, even if their text differs. That's deliberate:
  franchise posts often swap the game's name into the body. Short, generic titles like "Patch Notes" only merge when the body text matches too.
