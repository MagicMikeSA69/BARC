# IME — HX‑6 Aurora launch page

A static, dependency‑free product announcement page for a fictional egg‑hatchery
machine maker, laid out in the style of a long‑form flagship launch post
(fixed nav → article header → hero art → narrow prose column with wide media
breakouts → footer).

## Run it

Open `index.html` directly, or serve the folder:

```sh
python3 -m http.server 8000
# then visit http://localhost:8000
```

There is no build step. The page works with GitHub Pages as‑is.

## Structure

```
index.html            page markup and inline SVG illustrations
assets/css/styles.css tokens (light + dark), layout, components
assets/js/main.js     nav state, mobile menu, theme toggle, tabs, reveal, chart tooltips, share
assets/js/hatch.js    scroll-driven hatch sequence (sticky hatcher window; egg pips, zips, cap lifts, chick counted)
assets/js/fluid.js    cursor‑reactive WebGL egg‑liquid layer: albumen film + yolk core (skipped under reduced motion or without WebGL)
assets/img/favicon.svg
```

## Customising

- **Brand name, product names, copy** live only in `index.html`.
- **Colours** are CSS custom properties at the top of `styles.css`. Light and dark
  values are defined separately; the chart series colours (`--s1`..`--s3`) were
  validated for colour‑vision‑deficiency separation and contrast in both modes,
  so re‑validate if you change them.
- **Benchmark figures** are placeholders for a fictional trial. Each chart bar
  carries its value in `style="--v:…"` and `data-value`, and the table view
  under the chart mirrors the same numbers.
- **Theme**: follows the OS by default; the toggle in the nav overrides it and
  remembers the choice in `localStorage`.
