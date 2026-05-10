/* ════════════════════════════════════════════════════════════════
   Ons Huisje — Cloud sync via Supabase  (utility script, NOT JSX)
   ────────────────────────────────────────────────────────────────
   Werkt offline-first:
   • Lokale localStorage blijft de bron van waarheid op het toestel.
   • Bij online: lees cloud bij start, push bij elke wijziging.
   • Realtime subscription: partner ziet wijzigingen direct.
   • Wachtwoord = "kamer-id" → beide toestellen gebruiken hetzelfde id.

   Supabase-tabel die je éénmalig moet aanmaken (SQL uitvoeren in Supabase):

     create table public.huisje_state (
       room text primary key,
       data jsonb not null,
       updated_at timestamptz not null default now(),
       updated_by text
     );
     alter table public.huisje_state enable row level security;
     create policy "anon read"   on public.huisje_state for select using (true);
     create policy "anon insert" on public.huisje_state for insert with check (true);
     create policy "anon update" on public.huisje_state for update using (true);
     alter publication supabase_realtime add table public.huisje_state;

   ════════════════════════════════════════════════════════════════ */
(function(){
  const SYNC_CFG_KEY = "onshuisje-sync-config";

  function loadSyncConfig() {
    try {
      const raw = localStorage.getItem(SYNC_CFG_KEY);
      if (!raw) return null;
      const cfg = JSON.parse(raw);
      if (!cfg.url || !cfg.anonKey || !cfg.room) return null;
      return cfg;
    } catch { return null; }
  }
  function saveSyncConfig(cfg) {
    if (cfg) localStorage.setItem(SYNC_CFG_KEY, JSON.stringify(cfg));
    else     localStorage.removeItem(SYNC_CFG_KEY);
  }

  async function hashPassword(pw) {
    const enc = new TextEncoder().encode("onshuisje::" + pw);
    const buf = await crypto.subtle.digest("SHA-256", enc);
    return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2,"0")).join("").slice(0, 32);
  }

  function getDeviceId() {
    let id = localStorage.getItem("onshuisje-device");
    if (!id) {
      id = (navigator.userAgent.match(/iPhone|iPad|Android|Mobile/i) ? "📱" : "💻")
         + " " + Math.random().toString(36).slice(2,7);
      localStorage.setItem("onshuisje-device", id);
    }
    return id;
  }

  // Test of URL/key correct zijn en de tabel bestaat — gebruikt de supabase-client
  // (die parseert de URL betrouwbaarder dan een raw fetch).
  async function testConnection(url, anonKey) {
    const u = url.trim().replace(/\/$/, "");
    if (!window.supabase) {
      return { ok:false, reason:"Supabase client kon niet laden. Check je internetverbinding en herlaad de pagina." };
    }
    let client;
    try {
      client = window.supabase.createClient(u, anonKey);
    } catch (e) {
      return { ok:false, reason:"URL of anon-key heeft een verkeerd formaat.", raw:String(e) };
    }
    try {
      const { error } = await client.from("huisje_state").select("room").limit(1);
      if (!error) return { ok:true };
      const msg  = error.message || "";
      const code = error.code || "";
      const det  = error.details || "";
      const raw  = JSON.stringify(error, null, 2);
      if (code === "PGRST205" || /schema cache/i.test(msg)) {
        return { ok:false, reason:"Supabase ziet de tabel nog niet (schema cache loopt achter). Wacht 30s of ververs het schema, en klik 'Toch opslaan' hieronder.", raw };
      }
      if (code === "42P01" || /relation .* does not exist/i.test(msg)) {
        return { ok:false, reason:"Tabel 'huisje_state' bestaat nog niet. Voer de SQL uit in Supabase → SQL Editor.", raw };
      }
      if (code === "PGRST125") {
        return { ok:false, reason:"De Supabase URL heeft een ongeldig pad. Plak alleen de basis-URL (bv. https://xxxxx.supabase.co), zonder /rest/v1 of andere paden erachter.", raw };
      }
      if (/JWT|invalid api key|401|403/i.test(msg + code)) {
        return { ok:false, reason:"URL of anon-key klopt niet.", raw };
      }
      return { ok:false, reason:`Verbinding mislukt${code?` (${code})`:""}: ${msg || det || "onbekende fout"}`, raw };
    } catch (e) {
      return { ok:false, reason:"Geen verbinding met Supabase. Check internet en URL.", raw:String(e) };
    }
  }

  /* ════════════════════════════════════════
     useSync hook
  ════════════════════════════════════════ */
  function useSync({ payload, onPull, enabled, loaded }) {
    const [syncStatus, setSyncStatus] = React.useState("idle"); // idle | syncing | online | offline | error | disabled
    const [lastSync,   setLastSync]   = React.useState(null);
    const [lastEditor, setLastEditor] = React.useState(null);
    const clientRef   = React.useRef(null);
    const channelRef  = React.useRef(null);
    const debounceRef = React.useRef(null);
    const pushingRef  = React.useRef(false);
    const lastPushRef = React.useRef(0);
    const onPullRef   = React.useRef(onPull);
    onPullRef.current = onPull;

    const cfg = enabled ? loadSyncConfig() : null;

    // Connect & initial pull
    React.useEffect(() => {
      if (!enabled || !loaded) { setSyncStatus(enabled ? "idle" : "disabled"); return; }
      if (!cfg) { setSyncStatus("disabled"); return; }
      if (!window.supabase) { console.warn("[sync] supabase-js niet geladen"); setSyncStatus("error"); return; }

      let cancelled = false;
      setSyncStatus("syncing");

      const client = window.supabase.createClient(cfg.url, cfg.anonKey, {
        realtime: { params: { eventsPerSecond: 5 } }
      });
      clientRef.current = client;

      (async () => {
        try {
          const { data, error } = await client
            .from("huisje_state")
            .select("data, updated_at, updated_by")
            .eq("room", cfg.room)
            .maybeSingle();
          if (cancelled) return;
          if (error) { console.warn("[sync] pull error", error); setSyncStatus("error"); return; }
          if (data?.data && onPullRef.current) onPullRef.current(data.data);
          if (data?.updated_at) setLastSync(new Date(data.updated_at));
          if (data?.updated_by) setLastEditor(data.updated_by);
          setSyncStatus(navigator.onLine ? "online" : "offline");
        } catch (e) {
          console.warn("[sync] pull exception", e);
          if (!cancelled) setSyncStatus("error");
        }
      })();

      const ch = client.channel(`huisje-${cfg.room}`)
        .on("postgres_changes",
          { event:"*", schema:"public", table:"huisje_state", filter:`room=eq.${cfg.room}` },
          (p) => {
            const newData = p.new?.data;
            const editor  = p.new?.updated_by;
            if (!newData) return;
            // Negeer onze eigen pas-gepushte versie
            if (editor === getDeviceId() && Date.now() - lastPushRef.current < 3000) return;
            if (onPullRef.current) onPullRef.current(newData);
            if (p.new?.updated_at) setLastSync(new Date(p.new.updated_at));
            setLastEditor(editor || null);
          })
        .subscribe((status) => {
          if (cancelled) return;
          if (status === "SUBSCRIBED")           setSyncStatus(navigator.onLine ? "online" : "offline");
          else if (status === "CHANNEL_ERROR")   setSyncStatus("error");
          else if (status === "CLOSED")          setSyncStatus("offline");
        });
      channelRef.current = ch;

      return () => {
        cancelled = true;
        if (channelRef.current) clientRef.current?.removeChannel(channelRef.current);
        channelRef.current = null;
        clientRef.current  = null;
      };
    }, [enabled, loaded, cfg?.url, cfg?.anonKey, cfg?.room]);

    // Online/offline events
    React.useEffect(() => {
      if (!enabled) return;
      const on  = () => setSyncStatus(s => (s === "error" ? s : "online"));
      const off = () => setSyncStatus("offline");
      window.addEventListener("online", on);
      window.addEventListener("offline", off);
      return () => { window.removeEventListener("online", on); window.removeEventListener("offline", off); };
    }, [enabled]);

    // Debounced push
    React.useEffect(() => {
      if (!enabled || !loaded || !clientRef.current || !cfg) return;
      clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(async () => {
        if (pushingRef.current) return;
        pushingRef.current = true;
        lastPushRef.current = Date.now();
        setSyncStatus(prev => prev === "offline" ? "offline" : "syncing");
        try {
          const { error } = await clientRef.current
            .from("huisje_state")
            .upsert({
              room: cfg.room,
              data: payload,
              updated_at: new Date().toISOString(),
              updated_by: getDeviceId()
            }, { onConflict: "room" });
          if (error) {
            console.warn("[sync] push error", error);
            setSyncStatus(navigator.onLine ? "error" : "offline");
          } else {
            setLastSync(new Date());
            setSyncStatus(navigator.onLine ? "online" : "offline");
          }
        } catch (e) {
          console.warn("[sync] push exception", e);
          setSyncStatus(navigator.onLine ? "error" : "offline");
        } finally {
          pushingRef.current = false;
        }
      }, 700);
      return () => clearTimeout(debounceRef.current);
    }, [payload, enabled, loaded, cfg?.room]);

    return { syncStatus, lastSync, lastEditor, deviceId: getDeviceId() };
  }

  /* Globaal beschikbaar */
  window.OnsHuisjeSync = {
    loadSyncConfig, saveSyncConfig, hashPassword, getDeviceId, testConnection, useSync
  };
})();
