# Scratch Album

A mobile-first scratch card for photos. Scratch the foil off a Hebrew message, and at 75% the rest shatters away to reveal a photo. Tap for the next one, forever.

Static site, no build step. Uses Three.js and GSAP from a CDN.

## Publish on GitHub Pages (one time)

1. Create a new **public** repo on GitHub called `scratch-album`. Leave it empty, with no README.
2. From this folder:
   ```
   git remote add origin https://github.com/<your-username>/scratch-album.git
   git push -u origin main
   ```
3. On GitHub, open the repo, go to **Settings → Pages**, and under "Build and deployment" choose **Deploy from a branch**, then branch `main`, folder `/ (root)`, and click Save.
4. After a minute or two the site is live at `https://<your-username>.github.io/scratch-album/`.

## Add photos

1. Drop the originals into `imgs/`. That folder is git-ignored, so the full-size files and their GPS data stay on your computer.
2. Run `python tools/build_photos.py`. You need Pillow for this (`pip install pillow`). It makes stripped, phone-sized copies in `photos/` and rebuilds `photos.json`.
3. Commit and push.

## Edit messages

Edit `messages.txt` with one message per line. Lines starting with `#` are ignored. Commit and push.

## Preview locally

The page loads its files with `fetch`, so opening `index.html` directly from disk won't work. Run a tiny server instead:

```
python -m http.server 8000
```

Then open http://localhost:8000. To try it on your phone, use your computer's IP address on the same Wi-Fi network.

## Tuning

You can change these at the top of `js/app.js`:
- `CFG.revealAt`: how much has to be scratched before the reveal (0.75)
- `CFG.brush`: brush size
- `PALETTES`: the gradient colors
