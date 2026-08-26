# Room Change

A to-scale room planner for reworking a bedroom: drag furniture into place, mark
the paths that need to stay clear, and get called out when something (like a
cedar chest with no assigned job) is quietly becoming a junk pile.

## Using it

Open `index.html` in a browser (or visit the deployed site — see below).

- **Room Setup** — enter your room's width/length and where the door is, in inches.
- **+ Add Furniture** — add a piece with its real width/depth and a "job" (seating,
  storage, surface, light, footrest, decorative, other). Drag it to move it, drag
  the small orange handle to turn it to any angle.
- **+ Mark a Clear Path** — drag out a lane that has to stay open (e.g. door to
  closet); anything that overlaps it gets flagged.
- **Zones** — group furniture into a named zone (like "Reading Nook") and see a
  checklist of what it still needs.
- **Issues** — a running list of overlaps, blocked paths, pieces with no job, and
  zones missing something.

Everything saves automatically to your browser's local storage. Use **Save Backup
File** / **Load Backup File** to back up your layout to a file or move it to
another device/browser.

## Tech

Plain HTML/CSS/JS, no build step, no dependencies. Furniture and paths are SVG
shapes; collision and clearance checks use rotated-rectangle overlap math so
furniture can sit at any angle.

## Deploying

This is a static site — GitHub Pages can serve it directly. In the repo's
**Settings → Pages**, set the source to "Deploy from a branch," branch `main`,
folder `/ (root)`.
