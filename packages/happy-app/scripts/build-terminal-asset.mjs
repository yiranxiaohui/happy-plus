// Builds a self-contained HTML file that hosts xterm.js for the native webview.
// Inlines xterm's UMD JS + CSS so the webview needs no network. Run via
// `pnpm build:terminal-asset` and commit the output (assets/terminal/index.html).
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, '..');
const repoRoot = resolve(pkgRoot, '..', '..');

// pnpm may hoist packages to the repo root node_modules rather than the
// package-level node_modules. Resolve from whichever location has the file.
function req(p) {
  const pkgPath = resolve(pkgRoot, 'node_modules', p);
  const rootPath = resolve(repoRoot, 'node_modules', p);
  if (existsSync(pkgPath)) return readFileSync(pkgPath, 'utf8');
  if (existsSync(rootPath)) return readFileSync(rootPath, 'utf8');
  throw new Error(`Cannot find module file: ${p} (checked ${pkgPath} and ${rootPath})`);
}

const xtermJs = req('@xterm/xterm/lib/xterm.js');
const xtermCss = req('@xterm/xterm/css/xterm.css');
const fitJs = req('@xterm/addon-fit/lib/addon-fit.js');

const html = `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">
<style>${xtermCss}
html,body{margin:0;padding:0;height:100%;background:#000}#t{height:100%;width:100%}</style>
</head><body><div id="t"></div>
<script>${xtermJs}</script>
<script>${fitJs}</script>
<script>
(function(){
  var term = new Terminal({ convertEol:false, cursorBlink:true, fontFamily:'monospace', fontSize:13, theme:{background:'#000000'} });
  var fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open(document.getElementById('t'));
  fit.fit();
  function post(msg){ if(window.ReactNativeWebView) window.ReactNativeWebView.postMessage(JSON.stringify(msg)); }
  term.onData(function(d){ post({type:'input',data:d}); });
  function sendResize(){ try{ fit.fit(); }catch(e){} post({type:'resize',cols:term.cols,rows:term.rows}); }
  window.addEventListener('resize', sendResize);
  function onHostMessage(ev){
    try{
      var m = JSON.parse(ev.data);
      if(m.type==='write') term.write(m.data);
      else if(m.type==='clear') term.reset();
      else if(m.type==='fit') sendResize();
      else if(m.type==='focus') term.focus();
    }catch(e){}
  }
  document.addEventListener('message', onHostMessage);
  window.addEventListener('message', onHostMessage);
  setTimeout(sendResize, 50);
})();
</script></body></html>`;

mkdirSync(resolve(pkgRoot, 'assets/terminal'), { recursive: true });
writeFileSync(resolve(pkgRoot, 'assets/terminal/index.html'), html);
console.log('Wrote assets/terminal/index.html (' + html.length + ' bytes)');
