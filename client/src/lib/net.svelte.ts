/**
 * Browser connectivity state, surfaced to the header so the UI can show a
 * connected/disconnected indicator. `online` fires when the network interface
 * comes back; `offline` when it drops. Does NOT verify the server is reachable
 * (a LAN/Tailscale reachability probe is a separate concern).
 */
const net = $state<{ online: boolean }>({ online: typeof navigator !== 'undefined' ? navigator.onLine : true });

if (typeof window !== 'undefined') {
  window.addEventListener('online', () => {
    net.online = true;
  });
  window.addEventListener('offline', () => {
    net.online = false;
  });
}

export function getNet() {
  return net;
}
