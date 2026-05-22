# AI Video-Generation Prompts for GHCP-MEM

A working library of prompts for generating marketing/promo videos through
advanced video-generation tools (Runway Gen-3, Luma Dream Machine, Sora,
Descript, or whatever rendering pipeline we're using this quarter).

Most video generators work best with **short, scene-by-scene** instructions
rather than a single multi-minute monologue. The three prompts below are
self-contained and produce different visual aesthetics — pick the one that
matches the current campaign.

> **House style notes** (apply to any of the three):
>
> - **Skip text in the prompt itself.** AI video models still render words
>   as gibberish. Generate clean visuals first; overlay readable feature
>   text afterward in CapCut / Premiere / Descript / Canva.
> - **Aspect ratio:** append `--ar 16:9` for a horizontal feed
>   (LinkedIn timeline, blog hero, YouTube), or `--ar 9:16` for a mobile-
>   first vertical feed (LinkedIn mobile, TikTok, Reels, Shorts).
> - **Resolution:** target 1080p+ as input; downscale for delivery as needed.
> - **Brand palette:** dark slate `#0f172a` background · cyan accents
>   `#60a5fa` · neon green `#4ade80` · alarm pink `#fb7185`. Keeps every
>   render aesthetically consistent with the README, Marketplace banner,
>   and the SMIL `day-01-launch.svg` reel.

---

## Option 1 — Sleek & Cinematic Dark Mode (default)

_Best for a premium, high-end developer-tool aesthetic. Pairs naturally
with the README's slate palette and dark Marketplace banner._

> **Prompt:** A sleek, high-tech, cinematic 3D animation of a software
> development environment. The camera slowly pans across a dark mode user
> interface of Visual Studio Code. Glowing neon blue and purple neural
> network lines emerge from the VS Code editor panel and seamlessly fuse
> into a bright GitHub Copilot icon, symbolizing memory integration. The
> lighting is moody, futuristic, and premium with soft depth of field.
> High-resolution, 8k, photorealistic rendering of digital data flowing
> smoothly through abstract architectural layers. No text, clean motion,
> corporate tech aesthetic.

When to use: launch posts on LinkedIn / X, blog hero, splash page video.

---

## Option 2 — Explainer / Motion Graphics

_Best for clean, high-energy marketing visuals. Pairs with explainer-style
voice-over._

> **Prompt:** A 2D/3D clean vector motion graphics animation. The scene
> features an abstract, glowing digital brain floating inside a
> semi-transparent cube representing a local computer workspace. Glowing
> file icons, Git branch symbols, and terminal command lines fly into the
> brain, being compressed into neat data blocks. A padlock symbol flashes
> brief green light, representing local privacy and security. The color
> palette is modern tech-focused: deep slate gray backgrounds, vibrant
> teal, electric blue, and GitHub orange highlights. Smooth transitions,
> professional corporate explainer video style, 60fps.

When to use: feature deep-dives, conference reels, embedded product tours.

---

## Option 3 — Pain Point → Solution Sequence

_Best when the goal is conversion, not awareness — show the problem being
solved on-screen._

> **Prompt:** Split screen cinematic transition. On the left side, a
> frustrated software engineer in a dimly lit office stares at a monitor
> showing a repetitive AI chat window that says "Context lost." On the
> right side, the screen transitions into a brilliant, glowing
> golden-and-blue interface inside VS Code where complex code trees are
> instantly analyzed and memorized by an elegant AI core. The camera moves
> in a smooth, continuous tracking shot pushing forward into the digital
> code universe. Fast-paced, high contrast, visually engaging tech
> commercial.

When to use: Marketplace listing video, paid social ads, "why GHCP-MEM"
explainer videos.

---

## Companion artefacts in this repo

The SMIL-based, deterministic render path is the always-reproducible
fallback if any of the prompts above produce inconsistent output:

| Artefact | Path | Purpose |
|---|---|---|
| Canonical SVG (editable) | `images/demo/day-01-launch.svg` | Source of truth for the data-viz launch reel |
| Rendered MP4 (H.264, 720p, 12 fps) | `images/demo/day-01-launch.mp4` | README hero + offline-safe |
| Rendered GIF (gifski) | `images/demo/day-01-launch.gif` | README inline embed |
| Render script | `scripts/render-svg-to-video.mjs` | `node scripts/render-svg-to-video.mjs <in.svg> <out> --duration-ms N --fps 12 --width 1280 --height 720` |

Use the prompts above when we want cinematic / narrative footage that
SMIL can't easily produce; use the SMIL pipeline when we need byte-stable,
re-renderable, infinitely-tweakable data-viz.

---

<sub>_Last updated: this is a living reference — update the prompts as the
underlying video models improve. Keep the "house style notes" block in
sync with whatever palette the README is using._</sub>
