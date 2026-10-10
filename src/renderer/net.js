export function connect(url, { onState, onEvent, onError, onStatus }) {
  let ws = null;
  let closedByUser = false;
  let joinMsg = null;
  let retryTimer = null;

  const open = () => {
    onStatus('connecting');
    ws = new WebSocket(url);
    ws.onopen = () => {
      onStatus('connected');
      if (joinMsg) ws.send(JSON.stringify(joinMsg));
    };
    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      if (msg.type === 'state') onState(msg.state);
      else if (msg.type === 'event') onEvent(msg.event);
      else if (msg.type === 'error') onError(msg.message);
    };
    ws.onclose = () => {
      onStatus('disconnected');
      if (!closedByUser) retryTimer = setTimeout(open, 1500);
    };
    ws.onerror = () => {};
  };

  open();

  return {
    join(name, clientId) {
      joinMsg = { type: 'join', name, clientId };
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(joinMsg));
    },
    send(type, payload = {}) {
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type, ...payload }));
    },
    close() {
      closedByUser = true;
      clearTimeout(retryTimer);
      if (ws) ws.close();
    },
  };
}
