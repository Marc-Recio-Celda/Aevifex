/* Catalog identity and note rendering. This module has no instance taxonomy or DOM state. */
(function (host) {
  const escape = typeof module !== 'undefined' && module.exports ? require('./escape.js').esc : esc;
  const normalize = s => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const stem = p => p.replace(/\.md$/i, '');
  const title = f => f.title || stem(f.path.split('/').pop());
  const key = f => JSON.stringify([f.root, f.path]);
  function route({root = '', folder = '', path = '', q = '', anchor = '', all = false, searchRoot = ''} = {}) {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries({root, folder, note: path, q, anchor, all: all ? '1' : '', searchRoot: q && path ? searchRoot : ''})) if (v) params.set(k, v);
    return '#/library' + (params.size ? '?' + params : '');
  }
  function cleanPath(p) {
    const parts = [];
    for (const bit of p.split('/')) {
      if (!bit || bit === '.') continue;
      if (bit === '..') { if (!parts.length) return null; parts.pop(); }
      else parts.push(bit);
    }
    return parts.join('/');
  }
  function resolve(target, current, files, wiki = false) {
    try { target = decodeURIComponent(target); } catch {}
    if (/^(https?:|mailto:)/i.test(target)) return {kind: 'external', href: target};
    if (/^[a-z][\w+.-]*:/i.test(target) || target.startsWith('//')) return {kind: 'missing', target};
    const split = target.indexOf('#');
    const name = split < 0 ? target : target.slice(0, split);
    const anchor = split < 0 ? '' : target.slice(split + 1);
    if (!name && current) return {kind: 'note', file: current, anchor};
    const rootPath = f => stem(`${f.root}/${f.path}`);
    const named = stem(name).replace(/^\//, '');
    const relative = current && cleanPath(`${current.root}/${current.path.split('/').slice(0, -1).join('/')}/${name}`);
    // Explicit paths win. Basenames and aliases only resolve when unique.
    const exact = files.filter(f => rootPath(f) === named);
    const nearby = relative ? files.filter(f => rootPath(f) === stem(relative)) : [];
    let matches = (!wiki || /^(\.\.?\/)/.test(name)) && nearby.length ? nearby : exact;
    if (!matches.length && wiki) matches = files.filter(f => stem(f.path) === named || stem(f.path.split('/').pop()) === named);
    const unnumbered = value => stem(value.split('/').pop()).replace(/^\d+(?:[._]\d+)*[-_]/, '');
    const comparable = value => normalize(value).replace(/[-_\s]+/g, ' ').trim();
    if (!matches.length && wiki && !name.includes('/')) matches = files.filter(f => comparable(unnumbered(f.path)) === comparable(unnumbered(name)));
    if (!matches.length && wiki) matches = files.filter(f => (f.aliases || []).some(a => comparable(a) === comparable(unnumbered(name))));
    if (matches.length === 1) return {kind: 'note', file: matches[0], anchor};
    return {kind: matches.length ? 'ambiguous' : 'missing', target, matches, anchor};
  }
  function slug(text) {
    return normalize(text).replace(/[^\p{L}\p{N}\s_-]/gu, '').trim().replace(/\s+/g, '-');
  }
  function groups(files, root, folder = '') {
    const prefix = folder ? folder + '/' : '';
    const docs = [], children = new Map();
    for (const f of files.filter(f => f.root === root && f.path.startsWith(prefix))) {
      const rest = f.path.slice(prefix.length);
      if (!rest.includes('/')) docs.push(f);
      else {
        const name = rest.split('/')[0];
        children.set(name, (children.get(name) || 0) + 1);
      }
    }
    return {docs, folders: [...children].map(([name, count]) => ({name, count, path: prefix + name}))};
  }
  function render(source, current, files, dependencies = host, navigation = {}) {
    const md = dependencies.markdownit({html: false, breaks: false, linkify: false});
    const outline = [], problems = [], counts = new Map();
    md.core.ruler.before('block', 'wiki_table_pipes', state => {
      let fence = null;
      state.src = state.src.split('\n').map(line => {
        const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
        if (marker) {
          if (!fence) fence = marker;
          else if (marker[0] === fence[0] && marker.length >= fence.length) fence = null;
          return line;
        }
        return !fence && /^\s*\|/.test(line)
          ? line.replace(/\[\[[^\]\n]+\]\]/g, link => link.replace(/(?<!\\)\|/g, '\\|')) : line;
      }).join('\n');
    });
    function destination(raw, wiki) {
      const result = resolve(raw, current, files, wiki);
      if (result.kind === 'external') return {href: result.href, external: true};
      if (result.kind === 'note') return {href: (navigation.noteRoute || route)({root: result.file.root, path: result.file.path, anchor: result.anchor})};
      const index = problems.push(result) - 1;
      return {href: '#library-reference-' + index, problem: result.kind, index};
    }
    const openLink = md.renderer.rules.link_open || ((tokens, i, options, env, self) => self.renderToken(tokens, i, options));
    md.renderer.rules.link_open = (tokens, i, options, env, self) => {
      const d = destination(tokens[i].attrGet('href') || '', false);
      tokens[i].attrSet('href', d.href);
      if (d.external) { tokens[i].attrSet('target', '_blank'); tokens[i].attrSet('rel', 'noopener noreferrer'); }
      if (d.problem) { tokens[i].attrSet('class', 'note-unresolved'); tokens[i].attrSet('data-reference', String(d.index)); tokens[i].attrSet('title', d.problem === 'ambiguous' ? 'Varios documentos: elegir destino' : 'Documento no encontrado'); }
      return openLink(tokens, i, options, env, self);
    };
    md.inline.ruler.before('link', 'wiki', (state, silent) => {
      const match = /^(!?)\[\[([^\]\n]+)\]\]/.exec(state.src.slice(state.pos));
      if (!match) return false;
      if (!silent) {
        const token = state.push('wiki', '', 0);
        token.content = match[2]; token.meta = {embed: Boolean(match[1])};
      }
      state.pos += match[0].length; return true;
    });
    md.renderer.rules.wiki = (tokens, i) => {
      const [raw, ...labels] = tokens[i].content.split('|');
      const label = labels.join('|') || raw;
      const d = destination(raw, true);
      const text = tokens[i].meta.embed ? '↗ ' + (labels.length && /^\d+$/.test(label) ? raw : label) : label;
      return `<a href="${escape(d.href)}"${d.problem ? ` class="note-unresolved" data-reference="${d.index}" title="${d.problem === 'ambiguous' ? 'Varios documentos: elegir destino' : 'Documento o adjunto no encontrado'}"` : ''}${d.external ? ' target="_blank" rel="noopener noreferrer"' : ''}>${escape(text)}</a>`;
    };
    // Math is tokenized before Markdown can treat TeX underscores or backslashes as prose.
    md.inline.ruler.before('escape', 'math', (state, silent) => {
      const pos = state.pos, block = state.src.startsWith('$$', pos), marker = block ? '$$' : '$';
      if (state.src[pos] !== '$' || (!block && /\s/.test(state.src[pos + 1] || ' '))) return false;
      let end = pos + marker.length;
      while ((end = state.src.indexOf(marker, end)) >= 0 && state.src[end - 1] === '\\') end += marker.length;
      if (end < 0 || (!block && (/\s/.test(state.src[end - 1]) || /\d/.test(state.src[end + 1] || '')))) return false;
      if (!silent) { const t = state.push('math', '', 0); t.content = state.src.slice(pos + marker.length, end); t.meta = {block}; }
      state.pos = end + marker.length; return true;
    });
    const math = (content, displayMode) => {
      try { return dependencies.katex.renderToString(content, {displayMode, throwOnError: false, trust: false, maxExpand: 1000, strict: 'ignore'}); }
      catch { return `<code class="math-source">${escape(content)}</code>`; }
    };
    md.renderer.rules.math = (tokens, i) => math(tokens[i].content, tokens[i].meta.block);
    md.block.ruler.before('fence', 'math_block', (state, start, end, silent) => {
      const begin = state.bMarks[start] + state.tShift[start];
      if (!state.src.startsWith('$$', begin)) return false;
      const finish = state.src.indexOf('$$', begin + 2);
      if (finish < 0) return false;
      let next = start;
      while (next < end && state.eMarks[next] < finish + 2) next++;
      if (next >= end || state.src.slice(finish + 2, state.eMarks[next]).trim()) return false;
      if (!silent) { const t = state.push('math_block', '', 0); t.content = state.src.slice(begin + 2, finish); t.map = [start, next + 1]; }
      state.line = next + 1; return true;
    });
    md.renderer.rules.math_block = (tokens, i) => math(tokens[i].content, true);
    const fence = md.renderer.rules.fence;
    md.renderer.rules.fence = (tokens, i, options, env, self) => tokens[i].info.trim() === 'mermaid'
      ? `<figure class="note-diagram" data-live-source="${escape(tokens[i].content)}"><div class="diagram-output" aria-label="Diagrama" aria-busy="true">Cargando diagrama…</div><details><summary>Ver código del diagrama</summary><pre><code>${escape(tokens[i].content)}</code></pre></details></figure>`
      : fence(tokens, i, options, env, self);
    // Images only become links: absent or undeclared attachments must not be invented or fetched remotely.
    md.renderer.rules.image = (tokens, i) => {
      const t = tokens[i], d = destination(t.attrGet('src') || '', true);
      return `<a href="${escape(d.href)}"${d.problem ? ` class="note-unresolved" data-reference="${d.index}"` : ''}>${escape(t.content || t.attrGet('src'))}</a>`;
    };
    if (navigation.sourceLines) {
      for (const type of ['fence','code_block','math_block']) {
        const renderBlock=md.renderer.rules[type];
        md.renderer.rules[type]=(tokens,i,...args)=> {
          const map=tokens[i].map, offset=navigation.lineOffset || 0;
          return `<div data-source-line="${map[0]+1+offset}" data-source-end="${map[1]+offset}">${renderBlock(tokens,i,...args)}</div>`;
        };
      }
    }
    const tokens = md.parse(source, {});
    for (let i = 0; i < tokens.length; i++) {
      if (navigation.sourceLines && tokens[i].map && tokens[i].nesting === 1) {
        tokens[i].attrSet('data-source-line', String(tokens[i].map[0] + 1 + (navigation.lineOffset || 0)));
        tokens[i].attrSet('data-source-end', String(tokens[i].map[1] + (navigation.lineOffset || 0)));
      }
      if (tokens[i].type === 'blockquote_open' && tokens[i + 2]?.type === 'inline') {
        const children = tokens[i + 2].children || [], first = children[0];
        const marker = first?.type === 'text' && /^\[!([\w-]+)\][+-]?\s*/.exec(first.content);
        if (marker) {
          tokens[i].attrJoin('class', 'note-callout');
          first.content = first.content.slice(marker[0].length);
          children.unshift({type: 'callout_label', content: marker[1]});
        }
      }
      if (tokens[i].type !== 'heading_open') continue;
      const text = (tokens[i + 1].children || []).filter(t => t.type !== 'html_inline').map(t => t.content || '').join('');
      const base = slug(text) || 'section', n = counts.get(base) || 0;
      counts.set(base, n + 1);
      const id = 'note-heading-' + base + (n ? '-' + n : '');
      tokens[i].attrSet('id', id); outline.push({id, text, level: Number(tokens[i].tag.slice(1)), anchor: base + (n ? '-' + n : '')});
    }
    md.renderer.rules.callout_label = (tokens, i) => `<strong class="callout-label">${escape(tokens[i].content.toUpperCase())}</strong> `;
    const html = md.renderer.render(tokens, md.options, {});
    return {html, outline, problems};
  }
  const api = {escape, normalize, title, key, route, resolve, slug, groups, render};
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else host.Library = api;
})(globalThis);
