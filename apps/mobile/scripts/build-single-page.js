// Build a single self-contained HTML page from the Expo web export.
// Usage: node scripts/build-single-page.js <export-dir> <output.html>
// The result runs anywhere a static HTML file can be opened, with the demo node built in.
const fs = require('fs'); const path = require('path');
const out = process.argv[2]; const dest = process.argv[3];
const js = fs.readdirSync(path.join(out, '_expo/static/js/web')).find((f) => f.endsWith('.js'));
let bundle = fs.readFileSync(path.join(out, '_expo/static/js/web', js), 'utf8');
// Embed the one icon font the app uses so no relative asset path is needed.
const fontsDir = path.join(out, 'assets/__node_modules/@expo/vector-icons/build/vendor/react-native-vector-icons/Fonts');
for (const f of fs.readdirSync(fontsDir)) {
  if (!f.startsWith('Ionicons')) continue;
  const url = '/assets/__node_modules/@expo/vector-icons/build/vendor/react-native-vector-icons/Fonts/' + f;
  const data = 'data:font/ttf;base64,' + fs.readFileSync(path.join(fontsDir, f)).toString('base64');
  if (!bundle.includes(url)) throw new Error('font url not found in bundle: ' + url);
  bundle = bundle.split(url).join(data);
}
if (bundle.includes('</script')) throw new Error('bundle contains a closing script tag');
const page = `<title>BARC</title>
<style>
  :root { color-scheme: light; --bg: #F6F7F4; --fg: #14201B; }
  html, body { height: 100%; }
  body { overflow: hidden; background: var(--bg); color: var(--fg); margin: 0; }
  #root { display: flex; height: 100%; flex: 1; }
</style>
<div id="root"></div>
<script>
  // The app's router reads the page path on load; the artifact is served from
  // an arbitrary path, so start it from the root route.
  try { history.replaceState(history.state, '', '/'); } catch (e) {}
</script>
<script>${bundle}</script>
`;
fs.writeFileSync(dest, page);
console.log('assembled', dest, (fs.statSync(dest).size / 1e6).toFixed(2) + ' MB');
