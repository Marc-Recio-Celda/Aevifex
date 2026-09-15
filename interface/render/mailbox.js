/* Mailbox membership and reading routes. Source order is the operator's order. */
(function (host) {
  const normalize = value => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const isPending = entry => !['resolved', 'archived'].includes(entry.state);
  function state(entry) {
    return {open:{label:'Abierto'}, pending:{label:'Pendiente'}, resolved:{label:'Resuelto'}, archived:{label:'Archivado'}}[entry.state] || {label:'Estado sin clasificar'};
  }
  function location(params) {
    return {view:params.get('view') === 'archive' ? 'archive' : 'pending', project:params.get('project') || '', q:params.get('q') || '', id:params.get('id') || ''};
  }
  function route({view = 'pending', project = '', q = '', id = ''} = {}) {
    const params = new URLSearchParams();
    for (const [key,value] of Object.entries({view:view === 'archive' ? view : '',project,q,id})) if (value) params.set(key,value);
    return '#/inbox' + (params.size ? '?' + params : '');
  }
  function filter(entries, {view = 'pending', project = '', q = ''} = {}) {
    const needle = normalize(q.trim());
    return entries.filter(e => isPending(e) === (view !== 'archive') && (!project || e.project === project)
      && (!needle || normalize([e.title,e.body,e.project,e.author,e.destination,e.id].join(' ')).includes(needle)));
  }
  function select(entries, id) {
    const matches = entries.filter(e => e.id === id);
    return matches.length === 1 ? {kind:'entry',entry:matches[0]} : {kind:matches.length ? 'ambiguous' : 'missing'};
  }
  function request(source = '') {
    // Lift only an explicit request field. Unknown prose and duplicate fields keep their order.
    // Fenced examples are not fields; offsets preserve the complete original source separately.
    const fields = []; let offset = 0, fence = null;
    for (const line of source.split('\n')) {
      const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
      if (marker) {
        if (!fence) fence = marker;
        else if (marker[0] === fence[0] && marker.length >= fence.length) fence = null;
      } else if (!fence) {
        const match = /^\*\*([^*\n]+)\*\*\s*[—:–]?\s*/.exec(line);
        if (match) {
          const label = normalize(match[1]).replace(/[.:]$/, '').trim();
          const asks = /^(asks|why it needs .+|por que necesita .+|lo que hay que decidir|que se decide|que necesitas decidir|peticion)$/.test(label);
          if (asks || /^(serves|what|affects|description|what is happening|what it affects|descripcion|que pasa|que ocurre|que afecta|a que afecta)$/.test(label)) fields.push({asks, start:offset, content:offset+match[0].length});
        }
      }
      offset += line.length + 1;
    }
    const requests = fields.filter(f => f.asks);
    if (requests.length !== 1) return null;
    const found = requests[0], next = fields[fields.indexOf(found)+1];
    const end = next?.start ?? source.length, text = source.slice(found.content,end).trim();
    if (!text) return null;
    return {text, start:found.start,end, original:source.slice(found.start,end), remainder:(source.slice(0,found.start)+source.slice(end)).trim()};
  }
  const api = {isPending,state,location,route,filter,select,request};
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else host.Mailbox = api;
})(globalThis);
