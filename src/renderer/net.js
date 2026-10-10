const CONNECT_TIMEOUT_MS = 8000;

function closeMeaning(code) {
  if (code === 1000) return 'normal close';
  if (code === 1001) return 'host going away';
  if (code === 1006) return 'connection failed (refused, blocked, or dropped before it opened)';
  if (code === 1015) return 'TLS handshake failed';
  return '';
}

export function connect(url, { onState, onPositions, onEvent, onError, onStatus, onReset, onLog = () => {} }) {
  let ws = null;
  let closedByUser = false;
  let joinMsg = null;
  let retryTimer = null;
  let connectTimer = null;

  const log = (message) => onLog(message);
  const clearConnectTimer = () => {
    clearTimeout(connectTimer);
    connectTimer = null;
  };

  const open = () => {
    clearConnectTimer();
    onStatus('connecting');
    log(`connecting to ${url}`);

    let socket;
    try {
      socket = new WebSocket(url);
    } catch (err) {
      log(`could not open a socket to ${url}: ${err.message}`);
      onError(`Bad host address (${url}): ${err.message}`);
      onStatus('disconnected');
      return;
    }
    ws = socket;
    let gotState = false;

    connectTimer = setTimeout(() => {
      if (closedByUser || socket !== ws) return;
      if (socket.readyState === WebSocket.CONNECTING) {
        log(`timed out after ${CONNECT_TIMEOUT_MS / 1000}s: still connecting to ${url}. Nothing answered — wrong IP, wrong port, a firewall, or the host has not started a game.`);
        onError(`No response from ${url}. Check the IP and that your friend clicked Host game.`);
        socket.close();
        return;
      }
      if (socket.readyState === WebSocket.OPEN && !gotState) {
        log(`timed out after ${CONNECT_TIMEOUT_MS / 1000}s: socket to ${url} is open, but no game state arrived. The join may have been ignored.`);
        onError(`Connected to ${url}, but the host never sent the game.`);
      }
    }, CONNECT_TIMEOUT_MS);

    socket.onopen = () => {
      log(`socket open to ${url}`);
      onStatus('connected');
      if (!joinMsg) {
        log('socket is open, but the join message was not ready');
        return;
      }
      try {
        log(`sending join as "${joinMsg.name}"`);
        socket.send(JSON.stringify(joinMsg));
      } catch (err) {
        log(`failed to send join to ${url}: ${err.message}`);
        onError(`Could not send join: ${err.message}`);
      }
    };
    socket.onmessage = (e) => {
      let msg;
      try {
        msg = JSON.parse(e.data);
      } catch (err) {
        log(`host sent a message that was not JSON: ${err.message}`);
        return;
      }
      if (msg.type === 'welcome') {
        log(`host accepted join, player id ${msg.playerId}`);
      } else if (msg.type === 'reset') {
        log('server ended the game in progress');
        if (onReset) onReset();
      } else if (msg.type === 'state') {
        if (!gotState) {
          gotState = true;
          clearConnectTimer();
          const count = msg.state && msg.state.players ? msg.state.players.length : 0;
          log(`received game state (phase=${msg.state && msg.state.phase}, players=${count})`);
        }
        onState(msg.state);
      } else if (msg.type === 'positions') {
        if (onPositions) onPositions(msg.positions);
      } else if (msg.type === 'event') {
        onEvent(msg.event);
      } else if (msg.type === 'error') {
        log(`host rejected the request: ${msg.message}`);
        onError(msg.message);
      } else {
        log(`unexpected message from host: ${msg.type}`);
      }
    };
    socket.onclose = (ev) => {
      if (socket !== ws) return;
      clearConnectTimer();
      const meaning = closeMeaning(ev.code);
      const reason = ev.reason ? ` reason="${ev.reason}"` : '';
      log(`socket closed code=${ev.code}${meaning ? ` (${meaning})` : ''}${reason} url=${url}`);
      onStatus('disconnected');
      if (!closedByUser) {
        log('retrying in 1.5s');
        retryTimer = setTimeout(open, 1500);
      }
    };
    socket.onerror = () => {
      log(`socket error talking to ${url} (readyState=${socket.readyState}). The close event that follows has the reason code.`);
    };
  };

  open();

  return {
    join(name, clientId) {
      joinMsg = { type: 'join', name, clientId };
      if (ws && ws.readyState === WebSocket.OPEN) {
        try {
          log(`sending join as "${name}"`);
          ws.send(JSON.stringify(joinMsg));
        } catch (err) {
          log(`failed to send join: ${err.message}`);
          onError(`Could not send join: ${err.message}`);
        }
      } else {
        log(`join for "${name}" is waiting for the socket (readyState=${ws ? ws.readyState : 'none'})`);
      }
    },
    send(type, payload = {}) {
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type, ...payload }));
    },
    close() {
      closedByUser = true;
      clearTimeout(retryTimer);
      clearConnectTimer();
      if (ws) ws.close();
    },
  };
}
