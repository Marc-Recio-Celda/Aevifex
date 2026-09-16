/* A single reading room over the adapter's declared capture root. */
(function(host) {
  const normalize = s => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
  function matches(text, query) {
    const q=normalize(query), value=normalize(text);
    return /^[a-z]+-\d+$/.test(q)
      ? new RegExp(`(^|[^\\p{L}\\p{N}_-])${q}($|[^\\p{L}\\p{N}_-])`,'u').test(value)
      : value.includes(q);
  }
  function matchLine(source, query, hint=0) {
    if(!query) return hint;
    const lines=source.split('\n');
    if(hint>0 && hint<=lines.length && matches(lines[hint-1],query)) return hint;
    return lines.findIndex(line=>matches(line,query))+1;
  }
  const folder = file => file.path.split('/').slice(0,-1).join('/') || '.';
  const label = (file, config) => config.file_labels?.[file.path] || config.sheet_names?.[file.path.split('/').pop()] || file.path.split('/').pop().replace(/\.md$/i,'');
  function files(tree) { return tree?.notebook?.available ? (tree.files || []).filter(f=>f.root===tree.notebook.root) : []; }
  function groups(catalog,config,projects=[]) {
    const grouped = new Map();
    for(const f of catalog) {
      if(f.path === config.guide) continue;
      const path=folder(f);
      if(!grouped.has(path)) grouped.set(path,[]);
      grouped.get(path).push(f);
    }
    return [...grouped].map(([path,files])=>{
      const declared=(config.groups || []).find(g=>g.path === path) || {};
      const matches=projects.filter(p=>declared.project ? p.name===declared.project : p.lab && (path===`${p.lab}/${p.name}` || path.startsWith(`${p.lab}/${p.name}/`)));
      return {path,files,label:declared.label || (path==='.' ? 'General' : path.split('/').pop()),description:declared.description || '',context:path==='.'?'':path.split('/').slice(0,-1).join(' / '),project:matches.length===1?matches[0]:null};
    }).sort((a,b)=>a.path==='.'?-1:b.path==='.'?1:a.path.localeCompare(b.path));
  }
  function location(params) { return {folder:params.get('folder')||'',path:params.get('note')||'',q:params.get('q')||'',anchor:params.get('anchor')||'',line:Number(params.get('line'))>0?Number(params.get('line')):0}; }
  function route({folder='',path='',q='',anchor='',line=0}={}) {
    const params=new URLSearchParams();
    for(const [k,v] of Object.entries({folder,note:path,q,anchor,line:line||''})) if(v) params.set(k,v);
    return '#/notebook'+(params.size?'?'+params:'');
  }
  function results(catalog,config,loc,hits=[]) {
    const scoped=catalog.filter(f=>!loc.folder || folder(f)===loc.folder);
    const byPath=new Map();
    for(const f of scoped) if(matches([label(f,config),f.path,f.title,...(f.aliases||[])].join(' '),loc.q)) byPath.set(f.path,{file:f});
    for(const hit of hits) {
      const file=scoped.find(f=>f.root===hit.root && f.path===hit.path);
      if(file) byPath.set(file.path,{file,hit});
    }
    return [...byPath.values()];
  }
  const api={normalize,matches,matchLine,folder,label,files,groups,location,route,results};
  if(typeof module!=='undefined' && module.exports) module.exports=api;
  else host.Notebook=api;
})(globalThis);
