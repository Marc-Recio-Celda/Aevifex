#!/usr/bin/env python3
"""Aevifex & NEXUS Operations Interface Server.

Serves the operations centre cockpit with live polling and write layer.
Works standalone or connected to a NEXUS instance.

Usage:
    python3 server.py [--adapter /path/to/adapter.json] [--port 8770]

The adapter is given, never discovered — see find_default_adapter.
"""

import argparse
import gzip
import http.server
import importlib
import mimetypes
import json
import os
import re
import socketserver
import subprocess
import sys
import urllib.parse
from pathlib import Path

HERE = Path(__file__).resolve().parent
PAGE = HERE / "index.html"     # one page file; app.html was a byte-identical copy

UI = HERE / "ui"

# Try importing model if present
sys.path.insert(0, str(HERE / "model"))
try:
    import parse as model
except Exception as e:                       # the engine can serve a page without a
    model = None                             # model; it must never invent one
    _MODEL_ERROR = e
else:
    _MODEL_ERROR = None

# ⛔ Defined ONCE, in the model. A second copy here diverges, and then the same adapter is
# valid or invalid depending on whether an import succeeded — with nothing in the output
# saying which (`Aevifex:AX-20`).
KINDS = set(model.KINDS) if model else set()


class AdapterError(Exception):
    """Raised with a message written for a person, never a stack trace."""


def find_default_adapter():
    """The adapter is given, never guessed.

    An earlier version searched three hard-coded paths inside an operations centre.
    That is the one thing this engine may not know (`interface:AX-1`, `D4`): a
    default root is the convenience that turns a generic program into one that runs
    on a single machine, and it makes the axiom's own check unable to tell the
    sanctioned default from a leak.

    An environment variable is fine — it is the operator naming their instance, not
    the engine assuming one.
    """
    env = os.environ.get("AEVIFEX_ADAPTER")
    if env and Path(env).is_file():
        return Path(env)
    return None


def load_adapter(path):
    if path is None:
        default_path = find_default_adapter()
        if default_path:
            path = default_path
        else:
            return {
                "title": "Aevifex & NEXUS Operations Cockpit",
                "root": HERE.parent,
                "sources": [],
                "path": None
            }

    p = Path(path).expanduser().resolve()
    if not p.is_file():
        raise AdapterError(f"Adapter not found: {p}")
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
    except json.JSONDecodeError as e:
        raise AdapterError(f"Adapter is not valid JSON ({p}): {e}")

    root = (p.parent / data.get("root", ".")).resolve()
    sources = data.get("sources", [])
    return {
        "title": data.get("title", "Operations centre"),
        "root": root,
        "sources": sources,
        # ⛔ De dónde salen las métricas lo declara la instancia, nunca el motor
        # (`interface:AX-1`): aquí no hay ninguna ruta a ningún script.
        "metrics": data.get("metrics"),
        # ⛔ Qué se puede navegar lo declara la instancia. El motor no nombra ninguna raíz.
        "browse": data.get("browse") or [],
        "library": data.get("library") or {},
        "notebook": data.get("notebook") or {},
        "references": data.get("references") or {},
        "path": str(p)
    }


# ── el navegador ────────────────────────────────────────────────────────────────────────
#
# ⛔ Esto ensancha a propósito una regla que este mismo fichero escribió en `/api/skill`:
# *«se pide por NOMBRE… un cliente que pudiera nombrar una ruta leería cualquier fichero que
# el servidor alcance»*. `read_file` ES ese cliente, porque un navegador no puede funcionar
# de otra forma. Así que la contención deja de ser una precaución y pasa a ser la función.
#
# ⚠️ Y la contención es de UNA pieza, aquí, no repartida por las rutas: una comprobación que
# hay que acordarse de llamar es una comprobación que un día no se llama.

def _browse_roots(adapter):
    """Las raíces navegables, **declaradas por la instancia** (`interface:AX-1`)."""
    out = []
    for rel in adapter.get("browse") or []:
        d = (adapter["root"] / rel).resolve()
        if d.is_dir():
            out.append(d)
    return out


def _contained(adapter, rel, root=None):
    """La ruta pedida, resuelta y **dentro** de una raíz navegable, o `None`.

    ⛔ Se comprueba sobre la ruta YA RESUELTA, que es lo que neutraliza `../`, las rutas
    absolutas y **los enlaces simbólicos que salen** — el que se olvida, porque `resolve()`
    los sigue y una comprobación sobre el texto de la ruta no los ve.
    ⚠️ El allowlist es de extensión: `.md` y nada más. Una lista de lo prohibido siempre
    tiene un hueco; una de lo permitido no.
    """
    if not rel or not isinstance(rel, str):
        return None
    # Query parameters have already been decoded once by parse_qs. Decoding again would
    # silently change a legitimate filename containing percent escapes into another path.
    if "\x00" in rel or not rel.endswith(".md"):
        return None
    matches = []
    for name, raiz in _browse_scopes(adapter):
        if root is not None and name != root:
            continue
        f = (raiz / rel).resolve()
        try:
            f.relative_to(raiz)               # lanza si cae fuera; no compara cadenas
        except ValueError:
            continue
        if f.is_file():
            matches.append(f)
    # An unscoped legacy link must never choose the first duplicate.
    return matches[0] if len(matches) == 1 else None


def _walk(raiz):
    """Los `.md` **realmente dentro** de `raiz`, resueltos.

    ⛔ `rglob` devuelve `raiz/atajo.md` para un enlace simbólico que apunta fuera, y
    `relative_to` sobre esa ruta sin resolver cae dentro siempre. Hay que resolver primero,
    igual que en `_contained` — y por eso las tres rutas pasan por aquí y no cada una por su
    cuenta. ⚠️ La primera versión de esto tenía la comprobación sólo en `_contained`, el
    árbol listaba el enlace, y **fue la prueba con planta la que lo encontró**, no la
    relectura.
    """
    for f in sorted(raiz.rglob("*.md")):
        try:
            real = f.resolve()
            real.relative_to(raiz)
        except (ValueError, OSError):
            continue
        if real.is_file():
            yield f, real


def _browse_scopes(adapter):
    return [(rel, (adapter["root"] / rel).resolve())
            for rel in adapter.get("browse", [])
            if (adapter["root"] / rel).resolve().is_dir()]


def _library_sections(adapter):
    declared = {name for name, _ in _browse_scopes(adapter)}
    sections, seen = [], set()
    for section in adapter.get("library", {}).get("sections", []):
        root = section.get("root")
        if root in declared and root not in seen:
            sections.append({"root": root, "label": section.get("label") or root})
            seen.add(root)
    return sections


def _notebook_metadata(adapter):
    config = adapter.get("notebook") or {}
    declared = {name for name, _ in _browse_scopes(adapter)}
    if config.get("root") not in declared:
        return {"available": False, "why": "Notebook no tiene una carpeta navegable declarada en el adaptador."}
    return {"available": True, **{k: config[k] for k in
            ("root", "guide", "groups", "file_labels", "sheet_names") if k in config}}


def _note_metadata(body):
    """Read simple title/alias metadata; preserve the full YAML in the document response."""
    aliases = []
    front = re.match(r"\A---\s*\n(.*?)\n---(?:\n|$)", body, re.S)
    if front:
        alias = re.search(r"^aliases?:[ \t]*(.*)(?:\n((?:[ \t]*-[^\n]*\n?)*))", front[1] + "\n", re.M)
        if alias:
            value = alias[1].strip()
            if value.startswith("[") and value.endswith("]"):
                import csv
                aliases = next(csv.reader([value[1:-1]], skipinitialspace=True))
            elif value:
                aliases = [value]
            else:
                aliases = re.findall(r"^[ \t]*-[ \t]+(.+)", alias[2], re.M)
            aliases = [v.strip().strip("\"'") for v in aliases if v.strip()]
        body = body[front.end():]
    title = re.search(r"^# +(.+)$", body, re.M)
    return {"title": title[1].strip() if title else "", "aliases": aliases}


def tree(adapter):
    """Catalog metadata only. Root identity and section labels belong to the adapter."""
    scopes = _browse_scopes(adapter)
    if not scopes:
        return {"available": False, "why": "El adaptador no declara carpetas navegables (browse)."}
    files = []
    for name, directory in scopes:
        for file, real in _walk(directory):
            try:
                metadata = _note_metadata(real.read_text(encoding="utf-8", errors="replace"))
                st = real.stat()
                files.append({"root": name, "path": file.relative_to(directory).as_posix(),
                              **metadata, "bytes": st.st_size, "mtime": int(st.st_mtime),
                              "version": f"{st.st_mtime_ns}:{st.st_size}"})
            except OSError:
                continue
    return {"available": True, "roots": [name for name, _ in scopes],
            "sections": _library_sections(adapter), "notebook": _notebook_metadata(adapter),
            "references": adapter.get("references") or {}, "files": files}


def read_file(adapter, rel, root=None):
    f = _contained(adapter, rel, root)
    if not f:
        return {"available": False, "why": "Documento ausente, ambiguo o fuera de las carpetas navegables."}
    return {"available": True, "root": root, "path": rel,
            "body": f.read_text(encoding="utf-8", errors="replace")}


def _project_scope(adapter, name):
    """Return the unique declared cartridge and its readable project directory."""
    if not model or not adapter.get("path"):
        return None, None
    projects = [p for p in model.parse_adapter(adapter["path"])["entities"]
                if p["kind"] == "project-state" and p.get("project") == name]
    if len(projects) != 1 or projects[0].get("ambiguous") or not projects[0].get("project_root"):
        return None, None
    project = projects[0]
    directory = (adapter["root"] / project["project_root"]).resolve()
    if not directory.is_dir() or not any(directory.is_relative_to(root) for root in _browse_roots(adapter)):
        return None, None
    return project, directory


def project_files(adapter, name):
    project, directory = _project_scope(adapter, name)
    if directory is None:
        return {"available": False, "why": "No hay un proyecto único y accesible con ese nombre."}
    docs = {str((adapter["root"] / d["path"]).resolve()): d for d in project["documents"]}
    files = []
    for path, real in _walk(directory):
        with real.open(encoding="utf-8", errors="replace") as handle:
            title = next((line[2:].strip() for _, line in zip(range(40), handle) if line.startswith("# ")), path.stem)
        stat = real.stat()
        doc = docs.get(str(real), {})
        files.append({"path": str(path.relative_to(directory)), "title": title,
                      "role": doc.get("role"), "primary": doc.get("primary", False),
                      "bytes": stat.st_size, "mtime_ns": stat.st_mtime_ns})
    return {"available": True, "project": name, "files": files}


def project_file(adapter, name, relative):
    project, directory = _project_scope(adapter, name)
    if directory is None or not relative or "\x00" in relative:
        return {"available": False, "why": "No se encuentra este documento del proyecto."}
    rel = Path(relative)
    if rel.is_absolute() or ".." in rel.parts or rel.suffix != ".md":
        return {"available": False, "why": "El documento está fuera de este proyecto."}
    path = (directory / rel).resolve()
    if not path.is_relative_to(directory) or not path.is_file():
        return {"available": False, "why": "No se encuentra este documento dentro del proyecto."}
    body = path.read_text(encoding="utf-8", errors="replace")
    outline, fence = [], None
    for i, line in enumerate(body.splitlines()):
        marker = re.match(r"^\s*(`{3,}|~{3,})", line)
        if marker:
            token = marker[1]
            if fence is None:
                fence = token
            elif token[0] == fence[0] and len(token) >= len(fence):
                fence = None
            continue
        if fence is None and (heading := re.match(r"^(#{1,6})\s+(.+)", line)):
            outline.append({"level": len(heading[1]), "title": model.clean(heading[2]), "line": i + 1})
    role = next((d["role"] for d in project["documents"] if (adapter["root"] / d["path"]).resolve() == path), None)
    objectives = []
    if role == "objectives":
        for line, row in model.table_rows(body.splitlines(), 0):
            values = list(row.values())
            identifier = model.clean(values[0]) if values else ""
            if model.BLOCK_ID.fullmatch(identifier) and identifier.startswith("O"):
                objectives.append({"id": identifier, "fields": list(row.items())[1:], "line": line})
    blocks, _ = model.parse_project_blocks(path, body) if role == "plan" else ([], [])
    return {"available": True, "project": name, "path": relative, "body": body,
            "outline": outline, "role": role, "objectives": objectives, "blocks": blocks,
            "mtime_ns": path.stat().st_mtime_ns}


def task_sheet(adapter, task_id):
    """Resolve only the selected task's declared markdown reference, inside browse roots.

    A scoped project reference selects its heading or exact table row. It is supporting
    context, not an inferred sequence of task steps. Missing and ambiguous links stay missing.
    """
    unavailable = lambda why: {"available": False, "why": why}
    if not model or not adapter.get("path"):
        return unavailable("No hay un adaptador disponible.")
    fronts = model.parse_adapter(adapter["path"])["entities"]
    task = next((e for e in fronts if e["kind"] == "front" and e["id"] == task_id), None)
    if not task:
        return unavailable("Esta tarea ya no está en el muro.")
    ref = task.get("sheet") or task.get("described_in") or ""
    match = re.match(r"^`?([^`\s,]+\.md)`?(.*)$", ref)
    if not match:
        return unavailable("Esta tarea todavía no tiene una hoja enlazada.")
    rel, tail = match.groups()
    token = tail.strip().strip("`").split()[0].rstrip("`,") if tail.strip().strip("`") else ""
    fragment = token if model.SUBBLOCK_ID.fullmatch(token) else None
    if token and model.ID_LIKE.match(token) and not fragment:
        return unavailable("El identificador de la sección no se reconoce: " + token)
    if Path(rel).is_absolute() or ".." in Path(rel).parts:
        return unavailable("La hoja está fuera de las carpetas de lectura.")
    allowed = {real for root in _browse_roots(adapter) for _, real in _walk(root)}
    # A full instance-relative path or a path beside the wall has an explicit base.
    candidates = {(adapter["root"] / rel).resolve(),
                  (adapter["root"] / task["file"]).parent.joinpath(rel).resolve()} & allowed
    if not candidates:
        candidates = {p for p in allowed if p.as_posix().endswith("/" + rel)}
    if len(candidates) != 1:
        return unavailable("No se encuentra la hoja enlazada." if not candidates
                           else "El enlace coincide con varias hojas; falta concretar la ruta.")
    path = next(iter(candidates))
    body = path.read_text(encoding="utf-8", errors="replace")
    if fragment:
        lines = body.splitlines()
        token = re.compile(r"(?<![\w.])" + re.escape(fragment) + r"(?![\w.])")
        heads = [(i, len(m[1])) for i, line in enumerate(lines)
                 if (m := re.match(r"^(#{1,6})\s+(.+)", line)) and token.search(m[2])]
        rows = [i for i, line in enumerate(lines) if line.startswith("|")
                and token.search(line.split("|")[1])]
        if len(heads) == 1:
            start, level = heads[0]
            end = next((i for i in range(start + 1, len(lines))
                        if (m := re.match(r"^(#{1,6})\s", lines[i])) and len(m[1]) <= level), len(lines))
            body = "\n".join(lines[start:end])
        elif not heads and len(rows) == 1:
            row = rows[0]
            start = row
            while start > 0 and lines[start - 1].startswith("|"):
                start -= 1
            body = "\n".join(lines[start:start + 2] + [lines[row]])
        else:
            return unavailable("La sección enlazada no se encuentra de forma inequívoca: " + fragment)
    # Only a task sheet explicitly identifies itself as such. A log or project roadmap
    # can be read, but its bullets never become invented 'next steps'.
    is_task = bool(re.search(r"^\*\*Task:\*\*", body, re.M)) and not fragment
    parsed, _ = model.parse_plan(path, body) if is_task else ([], [])
    current = re.search(r"^\*\*Now:\*\*\s*(.+)", body, re.M) if is_task else None
    meta = next((e for e in parsed if e["kind"] == "live-plan-meta"), {})
    return {"available": True, "path": os.path.relpath(path, adapter["root"]),
            "reference": ref, "body": body, "current": current[1] if current else None,
            "items": [e for e in parsed if e["kind"] == "plan-item" and e.get("section", "").lower() == "items"],
            "order_why": meta.get("order_why", "")}


def search(adapter, q, limit=200, library=False, root=None, documents=False):
    """El `grep` que el operador corre fuera. Sobre las mismas raíces y nada más."""
    q = (q or "").strip()
    if len(q) < 2:
        return {"available": False, "why": "hacen falta al menos dos caracteres"}
    needle, hits = q.lower(), []
    if documents:
        import unicodedata
        normalize = lambda value: "".join(c for c in unicodedata.normalize("NFD", value.lower()) if not unicodedata.combining(c))
        needle = normalize(q)
    identifier = re.compile(r"(?<![\w-])" + re.escape(needle) + r"(?![\w-])") if documents and re.fullmatch(r"[a-z]+-\d+", needle) else None
    allowed = {s["root"] for s in _library_sections(adapter)} if library else None
    for name, raiz in _browse_scopes(adapter):
        if (allowed is not None and name not in allowed) or (root and name != root):
            continue
        for f, real in _walk(raiz):
            try:
                for n, line in enumerate(real.read_text(encoding="utf-8", errors="replace")
                                         .splitlines(), 1):
                    text = normalize(line) if documents else line.lower()
                    if (identifier.search(text) if identifier else needle in text):
                        hits.append({"root": name, "path": str(f.relative_to(raiz)),
                                     "line": n, "text": line.strip()[:240]})
                        if len(hits) >= limit:
                            return {"available": True, "q": q, "hits": hits, "capped": True}
                        if library or documents:
                            break  # One result per document keeps long notes from hiding the rest.
            except OSError:
                continue
    return {"available": True, "q": q, "hits": hits, "capped": False}


def metrics(adapter):
    """Lo que mide el script que el adaptador declara, **verbatim**.

    ⛔ El motor no recalcula ni una cifra. `interface:I3.1` lo dice en una línea — *el
    trabajo es una vista, no un parser* — y escribir un segundo parser es exactamente lo
    que hay que no hacer: dos cosas que cuentan lo mismo acaban discrepando y ninguna
    declara cuál gana (`Aevifex:AX-20`).

    ⚠️ Sin `metrics` declarado devuelve `available: False` **y dice qué falta**, en vez de
    un objeto vacío que se lee como *cero* (`interface:AX-5`). Un tablero que enseña cero
    cuando lo que pasa es que no hay fuente es peor que uno vacío.
    """
    spec = adapter.get("metrics")
    if not spec:
        return {"available": False,
                "why": "el adaptador no declara `metrics`",
                "how": 'añade {"metrics": {"script": "<ruta>", "args": ["--json"]}} al adaptador'}
    script = (adapter["root"] / spec.get("script", "")).resolve()
    # ⛔ Sólo se ejecuta lo que el adaptador nombra. Ni la petición ni la query eligen nada.
    if not str(script).startswith(str(adapter["root"])) or not script.is_file():
        return {"available": False,
                "why": f"el script declarado no está o cae fuera de la raíz: {spec.get('script')!r}"}
    args = [str(a) for a in spec.get("args", ["--json"])]
    try:
        r = subprocess.run([sys.executable, str(script), *args], cwd=str(adapter["root"]),
                           capture_output=True, text=True, timeout=120)
    except (OSError, subprocess.SubprocessError) as e:
        return {"available": False, "why": f"{type(e).__name__}: {e}"}
    if r.returncode != 0:
        return {"available": False,
                "why": f"el script salió {r.returncode}",
                "stderr": (r.stderr or "").strip()[:400]}
    try:
        return {"available": True, "source": spec.get("script"), "data": json.loads(r.stdout)}
    except json.JSONDecodeError as e:
        return {"available": False, "why": f"el script no devolvió JSON: {e}"}


def stamp(adapter):
    """Cheap change token for live sync polling."""
    if not adapter.get("sources") and not adapter.get("browse"):
        return "standalone"
    bits = []
    for spec in adapter.get("sources", []):
        target_root = adapter["root"]
        if spec.get("root"):
            target_root = (target_root / spec["root"]).resolve()
        if spec.get("path"):
            f = target_root / spec["path"]
            if f.is_file():
                bits.append(f"{f}:{f.stat().st_mtime}")
        elif spec.get("glob"):
            for f in sorted(target_root.glob(spec["glob"])):
                if f.is_file():
                    bits.append(f"{f}:{f.stat().st_mtime}")
    for directory in _browse_roots(adapter):
        for path, real in _walk(directory):
            stat = real.stat()
            bits.append(f"{path}:{stat.st_mtime_ns}:{stat.st_size}")
    return str(hash("|".join(bits)))


DOCTRINE_ROOT = Path(os.environ.get("AEVIFEX_DOCTRINE_ROOT", HERE.parent))

# Which file answers which question, and the kind that reads it. The three levels of
# `AGENTS.md` §1 in the order a newcomer meets them.
DOCTRINE = [
    ("philosophy", "PHILOSOPHY.md", "philosophy"),
    ("axioms",     "AXIOMS.md",     "axioms"),
    ("agents",     "AGENTS.md",     "doc"),
    ("method",     "METHOD.md",     "doc"),
    ("flow",       "FLOW.md",       "doc"),
    ("readme",     "README.md",     "doc"),
]


def doctrine():
    """The structural files, parsed. A missing one is reported, never invented."""
    if not model:
        return {"entities": [], "problems": [{"why": f"the model failed to load: {_MODEL_ERROR}"}]}
    entities, problems = [], []
    for label, name, kind in DOCTRINE:
        f = DOCTRINE_ROOT / name
        if not f.is_file():
            problems.append({"file": str(f), "line": 0,
                             "why": f"the structural file {name} is not at the engine's root"})
            continue
        try:
            ents, probs = model.PARSERS[kind](f, f.read_text(encoding="utf-8"))
        except Exception as e:                    # a broken file loses its own page, never
            problems.append({"file": name, "line": 0, "why": str(e)})   # the whole view
            continue
        for e in ents:
            e["source"] = label
            e["file"] = name
        entities += ents
        problems += [dict(x) for x in probs]
    return {"root": str(DOCTRINE_ROOT), "entities": entities, "problems": problems}


def recent_lines(adapter):
    """Rangos de líneas cambiadas hoy, por fichero del registro.

    Dos fuentes, unidas: lo que está sin commitear (`git diff HEAD`) y lo que entró en los
    commits de hoy (`git log --since=midnight -p`). ⛔ Se leen las cabeceras de hunk, no el
    contenido: `@@ -a,b +c,d @@` dice exactamente qué líneas del fichero NUEVO cambiaron, que
    es lo único que hace falta para cruzarlo con la línea de cada entrada.
    """
    root = adapter.get("root")
    if not root or not Path(root).is_dir():
        return {}
    out = {}
    try:
        top = subprocess.run(["git", "-C", str(root), "rev-parse", "--show-toplevel"],
                             capture_output=True, text=True, timeout=5)
        if top.returncode != 0:
            return {}                     # no es un repositorio; no es un error
        for args in (["diff", "HEAD", "--unified=0"],
                     ["log", "--since=midnight", "-p", "--unified=0"]):
            r = subprocess.run(["git", "-C", str(root), *args],
                               capture_output=True, text=True, timeout=15)
            if r.returncode != 0:
                continue
            current = None
            for ln in r.stdout.splitlines():
                if ln.startswith("+++ b/"):
                    current = ln[6:].strip()
                elif ln.startswith("@@") and current:
                    m = re.search(r"\+(\d+)(?:,(\d+))?", ln)
                    if m:
                        start = int(m.group(1))
                        n = int(m.group(2) or 1)
                        out.setdefault(current, []).append([start, start + max(n, 1) - 1])
    except (OSError, subprocess.SubprocessError):
        return {}
    return out


def one_skill(adapter, name):
    """Un SKILL.md entero y los ficheros que lo acompañan.

    ⚠️ Los 19 SKILL.md de este repositorio suman 120 KB. Mandarlos en cada `/api/model`
    multiplicaría por veinte una respuesta que se pide cada dos segundos, para enseñar como
    mucho uno. Se pide el que se va a leer.
    """
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", name or ""):
        return {"error": "nombre de skill no válido"}
    for src in adapter.get("sources", []):
        if src.get("kind") != "skills":
            continue
        root = Path(adapter["root"])
        sroot = (root / src["root"]).resolve() if src.get("root") else root
        for f in sorted(sroot.glob(src.get("glob", ""))):
            if f.parent.name != name and f.stem != name:
                continue
            siblings = []
            for sib in sorted(f.parent.iterdir()):
                if sib.is_file() and sib != f and sib.suffix in (".md", ".txt"):
                    siblings.append({"name": sib.name,
                                     "body": sib.read_text(encoding="utf-8", errors="replace")})
            return {"name": name, "file": str(f.relative_to(sroot)),
                    "body": f.read_text(encoding="utf-8", errors="replace"),
                    "siblings": siblings}
    return {"error": f"ninguna fuente de skills declarada contiene {name!r}"}


def make_handler(adapter):
    class Handler(http.server.BaseHTTPRequestHandler):
        # ⚠️ Comprimir NO es `interface:I1.5`, y no hay que confundirlo con haberlo hecho.
        # `I1.5` es que el cliente deje de reconstruir cada fila en cada cambio; esto sólo
        # reduce lo que viaja. Medido 2026-09-06 sobre un centro real: `/api/model` pesa
        # **1,86 MB** y **476 KB** comprimido — un 74 % menos por una rama de stdlib, y el
        # navegador ya pide `gzip` sin que nadie toque el cliente. La cota de `I1.5` sigue
        # siendo la que dice el plan; lo que baja aquí es el coste de cada latido hasta ahí.
        # ⛔ Con umbral: comprimir 200 bytes gasta más CPU de la que ahorra en red.
        GZIP_MIN = 4096

        def _send(self, code, body, ctype="application/json"):
            if isinstance(body, (dict, list)):
                body = json.dumps(body, ensure_ascii=False)
            payload = body if isinstance(body, bytes) else body.encode("utf-8")
            encoding = None
            if (len(payload) >= self.GZIP_MIN
                    and "gzip" in self.headers.get("Accept-Encoding", "")):
                payload = gzip.compress(payload, 6)
                encoding = "gzip"
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            if encoding:
                self.send_header("Content-Encoding", encoding)
                # Sin esto una caché intermedia puede servir la versión comprimida a quien
                # no la pidió. Aquí no hay ninguna, y aun así se declara: la cabecera cuesta
                # nada y su ausencia es un fallo que sólo aparece cuando ya hay una.
                self.send_header("Vary", "Accept-Encoding")
            self.send_header("Content-Length", str(len(payload)))
            # ⛔ Aquí había `Access-Control-Allow-Origin: *`. La página se sirve desde este
            # mismo origen y todos sus `fetch` son relativos, así que CORS no le hacía falta
            # a nadie más que a un tercero: con esa cabecera, CUALQUIER web que el operador
            # abriera podía leerse el centro de operaciones entero. Un mismo origen no
            # necesita permiso; lo que la cabecera concedía era el permiso a los demás.
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(payload)

        def do_GET(self):
            path = self.path.split("?", 1)[0]
            if path in ("/", "/index.html", "/app.html"):
                if PAGE.is_file():
                    self._send(200, PAGE.read_text(encoding="utf-8"), "text/html; charset=utf-8")
                else:
                    self._send(404, "index.html not found", "text/plain")
            elif path == "/api/model":
                if model and adapter.get("path"):
                    try:
                        # Re-read from disk like everything else here does. Imported
                        # once at startup, an edited parser served a stale answer with
                        # nothing saying anything was wrong.
                        globals()['model'] = importlib.reload(model)
                        parsed = model.parse_adapter(adapter["path"])
                        self._send(200, parsed)
                    except Exception as e:
                        self._send(200, {"entities": [], "problems": [{"why": str(e)}]})
                else:
                    self._send(200, {"entities": [], "standalone": True})
            elif path == "/api/skill":
                # ⛔ Se pide por NOMBRE y se resuelve contra la fuente que el adaptador ya
                # declara. Un cliente que pudiera nombrar una ruta leería cualquier fichero
                # que el servidor alcance; uno que nombra una skill sólo alcanza las que la
                # instancia ha declarado. Es la misma regla que gobierna la escritura.
                name = urllib.parse.parse_qs(
                    self.path.split("?", 1)[1] if "?" in self.path else "").get("name", [""])[0]
                self._send(200, one_skill(adapter, name))
            elif path == "/api/recent":
                # Qué bloques del registro se han tocado hoy, leído de git. ⚠️ Es un EXTRA
                # sobre el estado que la entrada declara, nunca su sustituto: el estado
                # sobrevive a un recargado y cuenta lo que enrutó otro agente; esto sólo dice
                # «esto se movió hoy». Si el árbol no es un repositorio, devuelve vacío y la
                # vista no enseña la marca — degradar en silencio es correcto aquí porque la
                # información es un adorno, no un dato del que dependa nada.
                self._send(200, {"lines": recent_lines(adapter)})
            elif path == "/api/doctrine":
                # ⛔ Aevifex' own structural files, parsed rather than transcribed. The
                # engine ships INSIDE this repository, so `HERE.parent` is a structural
                # fact and not the guess `find_default_adapter` refuses to make: it is
                # the engine's own root, never an operations centre.
                #
                # ⚠️ The alternative was a copy of the philosophy inside the page, and
                # that copy had already drifted — describing a clause that no longer said
                # what the page claimed, and omitting one entirely, while looking
                # authoritative. `AX-20` names that failure and this endpoint is the fix.
                self._send(200, doctrine())
            elif path == "/api/tree":
                self._send(200, tree(adapter))
            elif path in ("/api/project-files", "/api/project-file"):
                params = urllib.parse.parse_qs(self.path.split("?", 1)[1] if "?" in self.path else "")
                name = params.get("project", [""])[0]
                result = (project_files(adapter, name) if path == "/api/project-files"
                          else project_file(adapter, name, params.get("path", [""])[0]))
                self._send(200 if result.get("available") else 404, result)
            elif path == "/api/task-sheet":
                task_id = urllib.parse.parse_qs(
                    self.path.split("?", 1)[1] if "?" in self.path else "").get("id", [""])[0]
                result = task_sheet(adapter, task_id)
                self._send(200 if result.get("available") else 404, result)
            elif path == "/api/file":
                params = urllib.parse.parse_qs(self.path.split("?", 1)[1] if "?" in self.path else "")
                r = read_file(adapter, params.get("path", [""])[0], params.get("root", [None])[0])
                self._send(200 if r.get("available") else 404, r)
            elif path == "/api/search":
                params = urllib.parse.parse_qs(self.path.split("?", 1)[1] if "?" in self.path else "")
                self._send(200, search(adapter, params.get("q", [""])[0],
                                     library=params.get("library") == ["1"], root=params.get("root", [None])[0],
                                     documents=params.get("documents") == ["1"]))
            elif path == "/api/metrics":
                # `interface:I3.1` — las firings de los roles son la única medida de la salud
                # del sistema, y eran lo único que esta interfaz no podía pintar. El script ya
                # las calculaba y nada las leía.
                self._send(200, metrics(adapter))
            elif path == "/api/stamp":
                self._send(200, {"stamp": stamp(adapter)})
            else:
                # Serve static files relative to interface root
                rel_path = path.lstrip("/")
                f = (HERE / rel_path).resolve()
                if not f.is_file():
                    f = (UI / rel_path).resolve()

                if f.is_file() and (HERE in f.parents or UI in f.parents):
                    ctype = mimetypes.guess_type(f.name)[0] or "application/octet-stream"
                    if ctype.startswith("text/") or ctype in ("application/javascript", "application/json"):
                        ctype += "; charset=utf-8"
                    self._send(200, f.read_bytes(), ctype)
                else:
                    self._send(404, f"Not found: {path}", "text/plain")

        # ⛔ `do_POST` y `do_PATCH` vivían aquí y se retiran 2026-09-07 por decisión del
        # operador: **la interfaz no escribe, en ninguna versión**. Sólo él edita su libreta,
        # y a mano. Sin manejadores, `BaseHTTPRequestHandler` contesta **501** a cualquier
        # método que no sea GET — que es la respuesta correcta y no una que haya que
        # mantener. ⚠️ Y es una garantía distinta de una comprobación: un servidor sin
        # superficie de escritura no puede escribir por un fallo, sólo por un cambio.

        def log_message(self, *args):
            pass

    return Handler


def main():
    ap = argparse.ArgumentParser(description="Aevifex Operations Cockpit Server")
    ap.add_argument("--adapter", help="path to adapter JSON")
    ap.add_argument("--port", type=int, default=8770)
    # ⛔ Escuchaba en `0.0.0.0`, es decir en toda la red. Este programa sirve el contenido de
    # un centro de operaciones privado y no autentica a nadie — y el propio proyecto lo
    # escribió en su `definition.md`: «does not leave localhost at v1 or v2». El valor por
    # defecto pasa a ser el que el proyecto declaró.
    # ⚠️ Y la bandera existe porque algún día se va a querer abrir desde otro dispositivo, y
    # eso debe ser una decisión escrita en la orden, no un descuido en una constante. La
    # diferencia entre las dos cosas es esta línea.
    ap.add_argument("--host", default="127.0.0.1",
                    help="interfaz donde escuchar (por defecto sólo esta máquina). "
                         "0.0.0.0 la expone a toda la red SIN autenticación")
    args = ap.parse_args()

    adapter = load_adapter(args.adapter)
    socketserver.TCPServer.allow_reuse_address = True
    with socketserver.TCPServer((args.host, args.port), make_handler(adapter)) as httpd:
        print(f"\n⚡ Aevifex & NEXUS Operations Cockpit")
        print(f"  URL:     http://localhost:{args.port}")
        print(f"  Adapter: {adapter.get('path') or 'Standalone'}")
        if args.host not in ("127.0.0.1", "localhost", "::1"):
            print(f"  ⚠️  ESCUCHANDO EN {args.host} — expuesto a la red y sin autenticación")
        print(f"  Ready for connections. (Ctrl+C to stop)\n")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nStopped.\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
