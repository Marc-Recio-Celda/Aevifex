/* Contextual reference links belong to the adapter, never to a built-in command catalog. */
(function(host) {
  const valid = href => typeof href === 'string' && /^#\/(?:library|project|skill|skills|cockpit|notebook|inbox|overview)(?:[/?]|$)/.test(href);
  const links = (config,context) => (config?.links?.[context] || []).filter(item=>item.label && valid(item.href));
  function redirect(config,tab='session') {
    const href=config?.legacy?.[tab] || config?.legacy?.default;
    return valid(href) ? href : '#/library';
  }
  const api={valid,links,redirect};
  if(typeof module!=='undefined' && module.exports) module.exports=api;
  else host.References=api;
})(globalThis);
