#!/usr/bin/env python3
"""Compile the Claude Design .dc.html mockups into standalone single-file pages.

The mockups are multi-file: a Claude Design runtime (support.js + React),
an <image-slot> component, and ~20 satellite HTML documents pulled in through
<iframe src="...">, each of which loads three.js from a CDN.

Artifact hosting serves a single HTML file and enforces a CSP that only allows
scripts from a short CDN allowlist (unpkg is not on it). So we:

  * inline support.js / image-slot.js, and redirect the runtime's React+Babel
    CDN fetches through its own `window.__resources` override hook;
  * embed every satellite document in a JS virtual filesystem and swap the
    iframes' `src` for `srcdoc` at runtime;
  * rewrite unpkg -> jsdelivr (allowed) and drop the now-mismatched SRI hashes;
  * replace france-map's runtime fetch() of the world atlas (blocked by CSP)
    with the France geometry inlined at build time.

Two modes: `cdn` (published output) and `local` (vendored copies of three/d3/
React so the result can be exercised offline in headless Chromium).
"""

from __future__ import annotations

import json
import re
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "project"
BUILD = Path(__file__).resolve().parent
VENDOR_LOCAL = "vendor"  # served next to the page in local mode

# --------------------------------------------------------------------------
# The six colour directions, in the order the user built them.
# --------------------------------------------------------------------------
VARIANTS = [
    {
        "file": "Accueil v2D - Bleu Nuit.dc.html",
        "slug": "bleu-nuit",
        "name": "Bleu Nuit",
        "tag": "Industriel & commercial",
        "desc": "Fond bleu nuit profond, grille technique claire, accents bleu acier, CTA orange signal. La version la plus aboutie : carrousels de modeles, cadres reglables, montages 3D au scroll.",
        "swatches": ["#0B1526", "#101D33", "#5B8DD6", "#F07C1F"],
        "ink": "#EDF2F9",
        "favicon": "\U0001F303",
    },
    {
        "file": "Accueil Multi-Pôles.dc.html",
        "slug": "papier-bordeaux",
        "name": "Papier / Bordeaux",
        "tag": "Le modele d'origine",
        "desc": "Fond creme, encre noire, bleu de trace, mono technique. Un imprimeur qui montre son savoir-faire.",
        "swatches": ["#FAF8F3", "#E4DFD3", "#2442C8", "#5C1F2B"],
        "ink": "#16171A",
        "favicon": "\U0001F4E6",
    },
    {
        "file": "Accueil Multi-Pôles - Industry.dc.html",
        "slug": "industry-acier",
        "name": "Industry / Acier",
        "tag": "Bureau d'etudes",
        "desc": "Gris clair, acier bleu-gris, Barlow Condensed, croix de reperage aux angles. Un industriel qui montre sa precision.",
        "swatches": ["#F2F2F3", "#D9DBDE", "#5980A6", "#2C3742"],
        "ink": "#2C3742",
        "favicon": "\U0001F529",
    },
    {
        "file": "Accueil v2A - Papier.dc.html",
        "slug": "v2a-papier",
        "name": "v2A Papier",
        "tag": "Editorial luxe",
        "desc": "Fond ivoire sans grille, titres serif (Source Serif), accent bordeaux. Le plus haut de gamme, le moins technique.",
        "swatches": ["#FBF9F4", "#EDE7DA", "#5C1F2B", "#8A7A5E"],
        "ink": "#1B1C20",
        "favicon": "\U0001F4DC",
    },
    {
        "file": "Accueil v2B - Charbon.dc.html",
        "slug": "v2b-charbon",
        "name": "v2B Charbon",
        "tag": "Showroom sombre",
        "desc": "Fond charbon, Space Grotesk, accent ambre, cadres 3D traites en vitrines. Met le mieux en valeur les maquettes carton blanc.",
        "swatches": ["#141414", "#1E1E1E", "#D9A441", "#8C8C8C"],
        "ink": "#EDEDED",
        "favicon": "\U0001F5A4",
    },
    {
        "file": "Accueil v2C - Blueprint.dc.html",
        "slug": "v2c-blueprint",
        "name": "v2C Blueprint",
        "tag": "Technique acier",
        "desc": "Barlow Condensed, bleu acier, grille conservee. L'esprit plan de decoupe pousse au bout.",
        "swatches": ["#F2F4F6", "#DDE3E9", "#2E5C8A", "#16171A"],
        "ink": "#16171A",
        "favicon": "\U0001F4D0",
    },
]

# Satellite documents referenced from the mockups' iframes.
SATELLITES = (
    ["fold-hero.html", "fold-etui.html", "fold-plv.html", "france-map.html"]
    + [f"modeles/{p.name}" for p in sorted((SRC / "modeles").glob("*.html"))]
)


# --------------------------------------------------------------------------
# CDN rewriting
# --------------------------------------------------------------------------
def rewrite_cdn(text: str, mode: str) -> str:
    """Point third-party module URLs at a host the artifact CSP allows.

    SRI hashes are stripped rather than recomputed: jsdelivr and unpkg serve
    byte-identical npm tarball contents today, but a hash that silently stops
    matching would take the whole page down, and these are public pinned
    versions either way.
    """
    if mode == "local":
        text = text.replace(
            "https://unpkg.com/three@0.184.0/", f"/{VENDOR_LOCAL}/three/"
        )
        text = text.replace(
            "https://unpkg.com/d3@7.9.0/dist/d3.min.js", f"/{VENDOR_LOCAL}/d3/dist/d3.min.js"
        )
        text = text.replace(
            "https://unpkg.com/topojson-client@3.1.0/dist/topojson-client.min.js",
            f"/{VENDOR_LOCAL}/topojson-client/dist/topojson-client.min.js",
        )
    else:
        text = text.replace("https://unpkg.com/", "https://cdn.jsdelivr.net/npm/")

    # Drop `integrity="..."` / `crossorigin` on <script>/<link> tags.
    text = re.sub(r'\s+integrity="[^"]*"', "", text)
    text = re.sub(r'\s+crossorigin(?:="[^"]*")?(?=[\s/>])', "", text)
    # Drop the importmap's "integrity" map (keyed by the old unpkg URLs).
    text = re.sub(
        r',\s*"integrity"\s*:\s*\{[^}]*\}', "", text, flags=re.S
    )
    return text


# --------------------------------------------------------------------------
# Satellite documents
# --------------------------------------------------------------------------
def france_geometry() -> str:
    return (BUILD / "france-metro.json").read_text(encoding="utf-8")


def inline_design_system(body: str) -> str:
    """Fold in the `_ds/<theme>/` stylesheet and bundle the Industry page links."""

    def css(m: re.Match) -> str:
        path = SRC / m.group(1)
        return "<style>\n" + path.read_text(encoding="utf-8") + "\n</style>" if path.exists() else ""

    def js(m: re.Match) -> str:
        path = SRC / m.group(1)
        if not path.exists():
            return ""
        return "<script>\n" + path.read_text(encoding="utf-8").replace("</script", "<\\/script") + "\n</script>"

    body = re.sub(r'<link[^>]*href="(_ds/[^"]+\.css)"[^>]*>', css, body)
    body = re.sub(r'<script src="(_ds/[^"]+\.js)"></script>', js, body)
    return body


def prepare_satellite(path: str, mode: str) -> str:
    text = (SRC / path).read_text(encoding="utf-8")

    # `three-d-stage.js` is a sibling <script src>; a srcdoc frame has no
    # sibling to resolve against, so fold it in. Its usage docblock quotes
    # `</script>`, which would close the inline block early.
    stage_tag = re.compile(r'<script src="\.?/?three-d-stage\.js"></script>')
    if stage_tag.search(text):
        stage = (SRC / "modeles" / "three-d-stage.js").read_text(encoding="utf-8")
        stage = stage.replace("</script", "<\\/script")
        text = stage_tag.sub(lambda _: "<script>\n" + stage + "\n</script>", text)

    if path == "france-map.html":
        # The world atlas is fetched at runtime; CSP blocks connect-src, so the
        # metropolitan-France MultiPolygon is inlined at build time instead.
        start = text.index("    const topo = await")
        end = text.index("    const Wv = 560")
        text = text[:start] + "    const metro = " + france_geometry() + ";\n" + text[end:]
        # topojson-client only existed to decode that fetch.
        text = re.sub(r'<script src="[^"]*topojson-client[^"]*"[^>]*></script>\s*', "", text)

    # A srcdoc frame has no query string of its own; the build injects the
    # value the parent asked for as `window.__MPQ`.
    text = text.replace("location.search", "(window.__MPQ||'')")

    text = rewrite_cdn(text, mode)
    return text


# --------------------------------------------------------------------------
# Runtime shim: iframe data-src -> srcdoc, served from the embedded VFS
# --------------------------------------------------------------------------
SHIM = r"""
(function () {
  var VFS = window.__MPVFS || {};
  var applied = new WeakMap();

  function resolve(raw) {
    if (!raw) return null;
    var s = String(raw).replace(/^\.\//, '');
    var i = s.indexOf('?');
    var path = i < 0 ? s : s.slice(0, i);
    var query = i < 0 ? '' : s.slice(i);
    var doc = VFS[path];
    if (typeof doc !== 'string') return null;
    var inject = '<script>window.__MPQ=' + JSON.stringify(query) + ';<\/script>';
    return doc.replace('<head>', '<head>' + inject);
  }

  function sync(el) {
    // <x-dc> holds the uncompiled template. The browser parses it into real
    // elements before the runtime swaps it for the rendered tree, and those
    // throwaway iframes would load a document and fire `onload="{{ ... }}"`.
    if (el.closest('x-dc')) return;
    var want = el.getAttribute('data-src');
    if (applied.get(el) === want) return;
    var html = resolve(want);
    if (html === null) return;
    applied.set(el, want);
    el.srcdoc = html;
  }

  function scan(root) {
    if (!root || root.nodeType !== 1) return;
    if (root.tagName === 'IFRAME' && root.hasAttribute('data-src')) sync(root);
    var list = root.querySelectorAll ? root.querySelectorAll('iframe[data-src]') : [];
    for (var i = 0; i < list.length; i++) sync(list[i]);
  }

  new MutationObserver(function (records) {
    for (var i = 0; i < records.length; i++) {
      var r = records[i];
      if (r.type === 'attributes') sync(r.target);
      else for (var j = 0; j < r.addedNodes.length; j++) scan(r.addedNodes[j]);
    }
  }).observe(document.documentElement, {
    subtree: true, childList: true,
    attributes: true, attributeFilter: ['data-src']
  });

  scan(document.documentElement);
  document.addEventListener('DOMContentLoaded', function () { scan(document.documentElement); });
})();
"""

# --------------------------------------------------------------------------
# Settings panel: the design tool's "Tweaks" props, exposed on the live page
# --------------------------------------------------------------------------
PANEL = r"""
(function () {
  var meta = window.__MPPROPS || {};
  var keys = Object.keys(meta);
  if (!keys.length) return;

  var state = {};
  keys.forEach(function (k) { state[k] = meta[k]["default"]; });

  function push() {
    try { window.__dcSetProps(window.__dcRootName(), state); } catch (e) {}
  }

  var open = false;
  var wrap = document.createElement('div');
  wrap.id = 'mp-tweaks';
  wrap.innerHTML =
    '<button type="button" id="mp-tweaks-toggle" aria-expanded="false">REGLAGES</button>' +
    '<div id="mp-tweaks-body" hidden></div>';
  var body = wrap.querySelector('#mp-tweaks-body');
  var toggle = wrap.querySelector('#mp-tweaks-toggle');

  var css = document.createElement('style');
  css.textContent =
    '#mp-tweaks{position:fixed;right:14px;bottom:14px;z-index:9999;' +
    'font:500 11px/1.4 ui-monospace,"JetBrains Mono",Menlo,monospace;letter-spacing:.1em}' +
    '#mp-tweaks-toggle{display:block;margin-left:auto;cursor:pointer;border:1px solid rgba(128,128,128,.55);' +
    'background:rgba(20,20,22,.86);color:#fff;padding:9px 13px;letter-spacing:.14em;font:inherit;font-weight:700}' +
    '#mp-tweaks-body{margin-top:8px;max-height:min(70vh,560px);overflow:auto;width:250px;' +
    'background:rgba(20,20,22,.94);color:#EDEDED;border:1px solid rgba(128,128,128,.45);padding:14px;' +
    'backdrop-filter:blur(8px);display:flex;flex-direction:column;gap:14px}' +
    '#mp-tweaks label{display:block;color:#A9AAB2;margin-bottom:6px;font-size:9.5px;letter-spacing:.16em;text-transform:uppercase}' +
    '#mp-tweaks select,#mp-tweaks input[type=range]{width:100%;font:inherit}' +
    '#mp-tweaks select{background:#101014;color:#EDEDED;border:1px solid rgba(128,128,128,.45);padding:6px}' +
    '#mp-tweaks .sw{display:flex;gap:6px;flex-wrap:wrap}' +
    '#mp-tweaks .sw button{width:30px;height:24px;border:1px solid rgba(255,255,255,.35);cursor:pointer;padding:0}' +
    '#mp-tweaks .sw button[aria-pressed=true]{outline:2px solid #fff;outline-offset:1px}' +
    '#mp-tweaks .chk{display:flex;align-items:center;gap:8px;color:#EDEDED}' +
    '#mp-tweaks .chk label{margin:0;color:#EDEDED}';
  document.head.appendChild(css);

  function field(key) {
    var m = meta[key], row = document.createElement('div');
    var title = key.replace(/([A-Z])/g, ' $1').replace(/^./, function (c) { return c.toUpperCase(); });

    if (m.editor === 'boolean') {
      row.className = 'chk';
      var cb = document.createElement('input');
      cb.type = 'checkbox'; cb.checked = !!state[key]; cb.id = 'mp-' + key;
      var lb = document.createElement('label'); lb.htmlFor = cb.id; lb.textContent = title;
      cb.onchange = function () { state[key] = cb.checked; push(); };
      row.appendChild(cb); row.appendChild(lb);
      return row;
    }

    var lab = document.createElement('label');
    lab.textContent = title;
    row.appendChild(lab);

    if (m.editor === 'color' && Array.isArray(m.options)) {
      var sw = document.createElement('div'); sw.className = 'sw';
      m.options.forEach(function (c) {
        var b = document.createElement('button');
        b.type = 'button'; b.style.background = c; b.title = c;
        b.setAttribute('aria-pressed', String(c === state[key]));
        b.onclick = function () {
          state[key] = c;
          sw.querySelectorAll('button').forEach(function (o) { o.setAttribute('aria-pressed', String(o === b)); });
          push();
        };
        sw.appendChild(b);
      });
      row.appendChild(sw);
    } else if (m.editor === 'enum') {
      var sel = document.createElement('select');
      (m.options || []).forEach(function (o) {
        var op = document.createElement('option');
        op.value = o; op.textContent = o; op.selected = o === state[key];
        sel.appendChild(op);
      });
      sel.onchange = function () { state[key] = sel.value; push(); };
      row.appendChild(sel);
    } else if (m.editor === 'range') {
      var rg = document.createElement('input');
      rg.type = 'range'; rg.min = m.min; rg.max = m.max; rg.step = m.step || 1; rg.value = state[key];
      var out = document.createElement('span');
      out.textContent = ' ' + state[key] + (m.unit || '');
      lab.appendChild(out);
      rg.oninput = function () {
        state[key] = Number(rg.value);
        out.textContent = ' ' + rg.value + (m.unit || '');
        push();
      };
      row.appendChild(rg);
    } else {
      return null;
    }
    return row;
  }

  keys.forEach(function (k) {
    var el = field(k);
    if (el) body.appendChild(el);
  });

  toggle.onclick = function () {
    open = !open;
    body.hidden = !open;
    toggle.setAttribute('aria-expanded', String(open));
  };

  function mount() { document.body.appendChild(wrap); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();
})();
"""


def js_string_block(code: str) -> str:
    """Wrap JS for inlining, neutralising any `</script>` inside string data."""
    return code.replace("</script>", "<\\/script>")


def build_variant(variant: dict, mode: str, out_dir: Path) -> Path:
    src_text = (SRC / variant["file"]).read_text(encoding="utf-8")

    body = src_text[src_text.index("<body>") + len("<body>"): src_text.rindex("</body>")]

    # image-slot.js is pulled in from inside <helmet>; the runtime re-creates
    # that node in <head>, where a relative src would 404. Inline it instead.
    body = body.replace('<script src="image-slot.js"></script>', "")

    # The Industry direction is the only one carrying a design-system bundle.
    body = inline_design_system(body)

    # Iframes are switched to data-src so the raw (pre-React) template parse
    # cannot fire off requests for satellite paths that do not exist here.
    body = re.sub(
        r"(<iframe\b[^>]*?)\ssrc=", r"\1 data-src=", body, flags=re.I
    )

    # Inline `on*="{{ handler }}"` attributes are real event handlers on the
    # raw template nodes the browser parses before the runtime compiles them;
    # an iframe fires `load` for about:blank straight away, and the handler
    # expression then throws on a name that only exists in component scope.
    handlers = sorted(set(re.findall(r'\son[a-zA-Z]+="\{\{\s*([A-Za-z_$][\w$]*)', body)))
    stubs = "var " + ", ".join(handlers) + ";" if handlers else ""

    body = rewrite_cdn(body, mode)

    props_match = re.search(r'data-props="(.*?)"\s*>', src_text, re.S)
    props_json = "{}"
    if props_match:
        raw = props_match.group(1)
        for a, b in (("&quot;", '"'), ("&amp;", "&"), ("&lt;", "<"), ("&gt;", ">"), ("&#39;", "'")):
            raw = raw.replace(a, b)
        try:
            props_json = json.dumps(json.loads(raw), ensure_ascii=False)
        except json.JSONDecodeError:
            props_json = "{}"

    vfs = {p: prepare_satellite(p, mode) for p in SATELLITES}

    if mode == "local":
        resources = {
            "https://unpkg.com/react@18.3.1/umd/react.production.min.js":
                f"/{VENDOR_LOCAL}/react/umd/react.production.min.js",
            "https://unpkg.com/react-dom@18.3.1/umd/react-dom.production.min.js":
                f"/{VENDOR_LOCAL}/react-dom/umd/react-dom.production.min.js",
            "https://unpkg.com/@babel/standalone@7.29.0/babel.min.js":
                f"/{VENDOR_LOCAL}/babel/babel.min.js",
        }
    else:
        resources = {
            "https://unpkg.com/react@18.3.1/umd/react.production.min.js":
                "https://cdn.jsdelivr.net/npm/react@18.3.1/umd/react.production.min.js",
            "https://unpkg.com/react-dom@18.3.1/umd/react-dom.production.min.js":
                "https://cdn.jsdelivr.net/npm/react-dom@18.3.1/umd/react-dom.production.min.js",
            "https://unpkg.com/@babel/standalone@7.29.0/babel.min.js":
                "https://cdn.jsdelivr.net/npm/@babel/standalone@7.29.0/babel.min.js",
        }

    support = (SRC / "support.js").read_text(encoding="utf-8")

    # <image-slot> hydrates dropped photos from a sidecar JSON next to the
    # source file. There is no sidecar on a published page and connect-src is
    # closed, so the fetch only produces a CSP error in the console.
    image_slot = (SRC / "image-slot.js").read_text(encoding="utf-8").replace(
        "loadP = fetch(STATE_FILE)", "loadP = Promise.reject()"
    )

    title = f"Multi-Pôles — {variant['name']}"
    out = f"""<title>{title}</title>
<script>
window.__resources = {json.dumps(resources)};
window.__MPPROPS = {js_string_block(props_json)};
window.__MPVFS = {js_string_block(json.dumps(vfs, ensure_ascii=False))};
</script>
<script>{stubs}</script>
<script>{js_string_block(SHIM)}</script>
<script>{js_string_block(image_slot)}</script>
<script>{js_string_block(support)}</script>
{body}
<script>{js_string_block(PANEL)}</script>
"""

    out_path = out_dir / f"{variant['slug']}.html"
    out_path.write_text(out, encoding="utf-8")
    return out_path


# Published artifact per direction, so the index can link out to them.
ARTIFACTS = {
    "bleu-nuit": "https://claude.ai/code/artifact/c56cb707-62a5-4c26-a3bd-d6a9b38bb02b",
    "papier-bordeaux": "https://claude.ai/code/artifact/69361b0f-7ba0-4eb2-811d-46ea3d4ec4c3",
    "industry-acier": "https://claude.ai/code/artifact/e0377429-e885-4144-adb1-c80aee377b28",
    "v2a-papier": "https://claude.ai/code/artifact/4a4e21c4-ca9f-43e7-a7cc-8bbb35d4429a",
    "v2b-charbon": "https://claude.ai/code/artifact/969cf0c1-fd10-46c9-8de0-64430634ecec",
    "v2c-blueprint": "https://claude.ai/code/artifact/0684f054-6547-4fb6-b48b-e7735014b993",
}


def build_dist(out_dir: Path) -> Path:
    """The deployable site, at the repository root.

    Both hosts serve a repository root directly — GitHub Pages from the branch,
    Hostinger's Git deployment into `public_html` — so the pages live there
    rather than in a build directory nobody would think to point a host at.
    """
    dist = ROOT

    for page in out_dir.glob("*.html"):
        shutil.copy2(page, dist / page.name)
    (dist / ".nojekyll").write_text("", encoding="utf-8")

    index = (BUILD / "index-artifacts.html").read_text(encoding="utf-8")
    for slug, url in ARTIFACTS.items():
        index = index.replace(f'href="{url}" target="_blank" rel="noopener"', f'href="{slug}.html"')
    # The artifact host wraps the body; a plain host needs the document itself.
    (dist / "index.html").write_text(
        '<!doctype html>\n<html lang="fr">\n<head>\n<meta charset="utf-8">\n'
        '<meta name="viewport" content="width=device-width, initial-scale=1">\n'
        "</head>\n<body>\n" + index + "\n</body>\n</html>\n",
        encoding="utf-8",
    )
    return dist


def main() -> None:
    mode = sys.argv[1] if len(sys.argv) > 1 else "cdn"
    assert mode in ("cdn", "local"), "mode must be 'cdn' or 'local'"
    out_dir = BUILD / ("out-local" if mode == "local" else "out")
    if out_dir.exists():
        shutil.rmtree(out_dir)
    out_dir.mkdir(parents=True)

    for v in VARIANTS:
        p = build_variant(v, mode, out_dir)
        print(f"{p.name:24s} {p.stat().st_size / 1024:8.1f} KB")

    if mode == "cdn":
        dist = build_dist(out_dir)
        print(f"\nsite at repository root: {len(list(dist.glob('*.html')))} pages")


if __name__ == "__main__":
    main()
