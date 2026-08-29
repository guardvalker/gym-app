// Motor de sync con Supabase para gym-app. Capa de servicio pura (sin tocar
// el DOM) — index.html la consume vía window.Sync y decide qué pintar. Si
// window.SUPABASE_CONFIG sigue con los placeholders, todo el módulo queda
// inerte y la app funciona exactamente igual que sin este archivo.
//
// A diferencia de lista-super (varios usuarios comparten una "lista" con
// sync granular por item), acá cada cuenta es dueña de un solo registro
// (tabla gy_data, fila por usuario_id) que guarda el JSON completo de
// templates+logs — no hay concepto de "unirse" a los datos de otra persona.
window.Sync = (function () {
  let sb = null;
  let cb = {};
  let currentUser = null;
  let channel = null;

  // Último payload que se sabe que llegó a Supabase (o vino de ahí), para no
  // reescribir si no cambió nada.
  let lastSyncedPayload = null;
  // Último payload pasado a pushData(), para poder reintentar al volver la
  // conexión sin que index.html tenga que saber nada de reintentos.
  let lastPushArg = null;

  function isConfigured() {
    const c = window.SUPABASE_CONFIG;
    return !!(c && c.url && c.anonKey && !c.url.includes('TU-PROYECTO'));
  }

  function fail(err) {
    console.error('[Sync]', err);
    cb.onSyncError && cb.onSyncError(err && err.message ? err.message : String(err));
  }

  function clone(x) { return JSON.parse(JSON.stringify(x)); }

  // ---- Auth ----

  async function sendOtp(email) {
    if (!sb) throw new Error('Supabase no está configurado');
    const { error } = await sb.auth.signInWithOtp({ email });
    if (error) throw error;
  }

  async function verifyOtp(email, token) {
    if (!sb) throw new Error('Supabase no está configurado');
    const { data, error } = await sb.auth.verifyOtp({ email, token, type: 'email' });
    if (error) throw error;
    // Seteamos currentUser acá en vez de esperar al listener de
    // onAuthStateChange (dispara async, con timing no garantizado) — si el
    // caller renderiza la UI apenas resuelve esta promesa, necesita ver el
    // usuario ya seteado.
    currentUser = data.user;
    subscribeRealtime();
    cb.onAuthChange && cb.onAuthChange(currentUser);
  }

  async function signOut() {
    if (!sb) return;
    unsubscribeRealtime();
    await sb.auth.signOut();
    currentUser = null;
    lastSyncedPayload = null;
    cb.onAuthChange && cb.onAuthChange(null);
  }

  function getUser() {
    return currentUser;
  }

  // ---- Lectura remota ----

  async function hasRemoteData() {
    if (!sb || !currentUser) return false;
    const { data, error } = await sb
      .from('gy_data')
      .select('usuario_id')
      .eq('usuario_id', currentUser.id)
      .maybeSingle();
    if (error) { fail(error); return false; }
    return !!data;
  }

  async function fetchRemote() {
    const { data, error } = await sb
      .from('gy_data')
      .select('payload')
      .eq('usuario_id', currentUser.id)
      .maybeSingle();
    if (error) throw error;
    return data ? data.payload : null;
  }

  async function pullNow() {
    if (!sb || !currentUser) return;
    try {
      const payload = await fetchRemote();
      if (payload) {
        lastSyncedPayload = clone(payload);
        cb.onRemoteData && cb.onRemoteData(payload);
      }
    } catch (err) {
      fail(err);
    }
  }

  function subscribeRealtime() {
    unsubscribeRealtime();
    channel = sb
      .channel(`gy-data-${currentUser.id}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'gy_data', filter: `usuario_id=eq.${currentUser.id}` },
        pullNow
      )
      .subscribe();
  }

  function unsubscribeRealtime() {
    if (channel) { sb.removeChannel(channel); channel = null; }
  }

  // ---- Push local -> remoto ----

  let pushTimer = null;
  function pushData(payload) {
    lastPushArg = payload;
    if (!sb || !currentUser) return;
    clearTimeout(pushTimer);
    pushTimer = setTimeout(() => doPush(payload), 500);
  }

  async function doPush(payload) {
    if (JSON.stringify(payload) === JSON.stringify(lastSyncedPayload)) return;
    try {
      const { error } = await sb
        .from('gy_data')
        .upsert({ usuario_id: currentUser.id, payload, updated_at: new Date().toISOString() });
      if (error) throw error;
      lastSyncedPayload = clone(payload);
      cb.onSynced && cb.onSynced();
    } catch (err) {
      fail(err);
    }
  }

  function retryPending() {
    if (lastPushArg) pushData(lastPushArg);
  }

  // ---- Init ----

  function init(callbacks) {
    cb = callbacks || {};
    if (!isConfigured()) return;
    sb = window.supabase.createClient(window.SUPABASE_CONFIG.url, window.SUPABASE_CONFIG.anonKey);

    const handleSession = (session) => {
      currentUser = session ? session.user : null;
      if (currentUser) subscribeRealtime(); else unsubscribeRealtime();
      cb.onAuthChange && cb.onAuthChange(currentUser);
    };

    sb.auth.onAuthStateChange((_event, session) => handleSession(session));
    sb.auth.getSession().then(({ data }) => handleSession(data.session));

    window.addEventListener('online', retryPending);
  }

  return {
    isConfigured,
    init,
    sendOtp,
    verifyOtp,
    signOut,
    getUser,
    hasRemoteData,
    pullNow,
    pushData,
  };
})();
