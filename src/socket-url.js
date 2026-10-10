'use strict';

// LAN joins stay ws://ip:port. A public hostname, or an https URL from Cloud Run,
// becomes a wss:// address on port 443.
function gameSocketUrl(addr, port) {
  const trimmed = String(addr || '').trim().replace(/\/+$/, '');
  if (/^wss?:\/\//i.test(trimmed)) return trimmed;
  if (/^https:\/\//i.test(trimmed)) return `wss://${trimmed.slice('https://'.length)}`;
  if (/^http:\/\//i.test(trimmed)) return `ws://${trimmed.slice('http://'.length)}`;
  const isIpv4 = /^\d{1,3}(\.\d{1,3}){3}$/.test(trimmed);
  if (!trimmed.includes(':') && !isIpv4 && trimmed.includes('.')) return `wss://${trimmed}`;
  const target = trimmed.includes(':') ? trimmed : `${trimmed}:${port}`;
  return `ws://${target}`;
}

module.exports = { gameSocketUrl };
