'use strict';

const os = require('os');
const { createGameServer } = require('./game-server');

const port = Number(process.env.VV_PORT) || 7777;
const server = createGameServer({ port });

server.ready.then(() => {
  const addresses = Object.values(os.networkInterfaces())
    .flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal)
    .map((i) => i.address);
  console.log('Players on the same Wi-Fi can join at:');
  for (const addr of addresses) console.log(`  ${addr}:${port}`);
});

process.on('SIGINT', () => {
  server.close();
  process.exit(0);
});
