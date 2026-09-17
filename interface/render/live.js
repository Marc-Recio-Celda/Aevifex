/* Entity reconciliation and DOM patches for background updates. No runtime dependency. */
(function(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.LiveModel = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function() {
  const entityKey = e => e.uid || e.id;
  function apply(previous, message) {
    let entities;
    const old = new Map((previous?.entities || []).map(e => [entityKey(e), e]));
    const changed = new Set();
    if (message.mode === 'delta') {
      if (!previous || previous.revision !== message.base) throw new Error('La revisión no coincide');
      const next = new Map(old);
      for (const id of message.remove || []) { changed.add(old.get(id)?.kind); next.delete(id); }
      for (const entry of message.upsert || []) {
        changed.add(old.get(entityKey(entry))?.kind); changed.add(entry.kind); next.set(entityKey(entry), entry);
      }
      const order = message.order || [...next.keys()];
      if (order.length !== next.size || new Set(order).size !== next.size || order.some(id => !next.has(id))) throw new Error('Orden de entidades incompleto');
      entities = order.map(id => next.get(id));
    } else {
      entities = (message.entities || []).map(e => {
        const existing = old.get(entityKey(e));
        if (existing && JSON.stringify(existing) === JSON.stringify(e)) return existing;
        changed.add(existing?.kind); changed.add(e.kind); return e;
      });
      const ids = new Set(entities.map(entityKey));
      if (ids.size !== entities.length) throw new Error('Identidades de entidad repetidas');
      for (const entry of old.values()) if (!ids.has(entityKey(entry))) changed.add(entry.kind);
    }
    // A changed order matters even when all entity bodies are unchanged.
    entities.forEach((e, i) => { if ((!previous?.entities?.[i] || entityKey(previous.entities[i]) !== entityKey(e))) changed.add(e.kind); });
    changed.delete(undefined);
    return {model: {...(message.mode === 'delta' ? {...previous, ...message.metadata} : message), entities,
      revision: message.revision, stamp: message.stamp}, changed};
  }

  function reuse(previous = [], next = [], key = e => e.id) {
    if (previous === next) return previous;
    const old = new Map(previous.map(e => [key(e), e]));
    const result = next.map(e => {
      const existing = old.get(key(e));
      return existing && JSON.stringify(existing) === JSON.stringify(e) ? existing : e;
    });
    return result.length === previous.length && result.every((e,i) => e === previous[i]) ? previous : result;
  }

  const identity = node => node.nodeType === 1 ? node.getAttribute('data-live-key') || node.id : '';
  const compatible = (a,b) => a && a.nodeType === b.nodeType && a.nodeName === b.nodeName;
  function children(target, source) {
    const old = [...target.childNodes], used = new Set();
    const keyed = new Map(old.filter(identity).map(node => [identity(node), node]));
    let cursor = target.firstChild;
    for (const fresh of [...source.childNodes]) {
      const key = identity(fresh);
      let node = key ? keyed.get(key) : old.find(candidate => !used.has(candidate) && !identity(candidate) && compatible(candidate, fresh));
      if (!compatible(node, fresh)) node = fresh.cloneNode(true);
      else patch(node, fresh);
      used.add(node);
      if (node !== cursor) target.insertBefore(node, cursor);
      cursor = node.nextSibling;
    }
    old.forEach(node => { if (!used.has(node)) node.remove(); });
  }
  function patch(target, source) {
    if (target.isEqualNode(source)) return;
    if (target.nodeType !== 1) { target.nodeValue = source.nodeValue; return; }
    const preserved = source.hasAttribute('data-live-source') && source.getAttribute('data-live-source') === target.getAttribute('data-live-source');
    // Expanded reading sections are a user's local reading state.
    const keep = name => target.tagName === 'DETAILS' && name === 'open';
    [...target.attributes].forEach(attr => { if (!source.hasAttribute(attr.name) && !keep(attr.name)) target.removeAttribute(attr.name); });
    [...source.attributes].forEach(attr => { if (!keep(attr.name) && target.getAttribute(attr.name) !== attr.value) target.setAttribute(attr.name, attr.value); });
    if (!preserved) children(target, source);
  }
  function paint(container, html) {
    const template = container.ownerDocument.createElement('template');
    template.innerHTML = html;
    children(container, template.content);
  }
  return {apply, reuse, paint};
});
