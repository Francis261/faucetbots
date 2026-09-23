import net from 'node:net';

const UPSTREAM_HOST = '127.0.0.1';
const UPSTREAM_PORT = 1080;
const UPSTREAM_USER = 'havearn';
const UPSTREAM_PASS = '986532';
const LISTEN_PORT = 1081;

const srv = net.createServer(client => {
  let targetHost = null;
  let targetPort = null;

  client.on('error', () => {});

  function sendSocks5ConnectReply(sock, success) {
    // reply: VER(0x05) REP CMD RSV ATYP BND.ADDR BND.PORT
    const reply = Buffer.from([0x05, success ? 0x00 : 0x01, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
    sock.write(reply);
  }

  client.once('data', buf => {
    // client greeting: VER NMETHODS METHODS...
    if (buf[0] !== 0x05) return client.end();
    client.write(Buffer.from([0x05, 0x00])); // NO AUTH required

    client.once('data', req => {
      // VER CMD RSV ATYP ...
      const ver = req[0], cmd = req[1], atyp = req[3];
      if (ver !== 0x05 || cmd !== 0x01) return client.end();
      let host, port;
      if (atyp === 0x01) {
        host = [...req.slice(4, 8)].join('.');
        port = req.readUInt16BE(8);
      } else if (atyp === 0x03) {
        const len = req[4];
        host = req.slice(5, 5 + len).toString();
        port = req.readUInt16BE(5 + len);
      } else if (atyp === 0x04) {
        host = [...req.slice(4, 20)].map(b => b.toString(16).padStart(2, '0')).join(':');
        port = req.readUInt16BE(20);
      } else return client.end();

      // connect to upstream SOCKS5 proxy with auth
      const up = net.createConnection({ host: UPSTREAM_HOST, port: UPSTREAM_PORT });
      up.on('error', () => { client.end(); });

      up.once('connect', () => {
        // upstream greeting: NO AUTH + USER/PASS methods [0x00, 0x02]
        up.write(Buffer.from([0x05, 0x02, 0x00, 0x02]));
        up.once('data', greet => {
          if (greet[1] === 0x02) {
            const u = Buffer.from(UPSTREAM_USER, 'utf8');
            const p = Buffer.from(UPSTREAM_PASS, 'utf8');
            const auth = Buffer.concat([
              Buffer.from([0x01, u.length]), u,
              Buffer.from([p.length]), p,
            ]);
            up.write(auth);
            up.once('data', authResp => {
              if (authResp[1] !== 0x00) return client.end();
              sendConnect(up);
            });
          } else if (greet[1] === 0x00) {
            sendConnect(up);
          } else return client.end();
        });
      });

      function sendConnect(up) {
        // build CONNECT request to target
        let addr;
        if (Buffer.byteLength(host, 'utf8') === host.length && /^[\d.]+$/.test(host)) {
          addr = Buffer.from([0x01, ...host.split('.').map(Number)]);
        } else {
          const h = Buffer.from(host, 'utf8');
          addr = Buffer.concat([Buffer.from([0x03, h.length]), h]);
        }
        const portBuf = Buffer.alloc(2);
        portBuf.writeUInt16BE(port);
        const connReq = Buffer.concat([Buffer.from([0x05, 0x01, 0x00]), addr, portBuf]);
        up.write(connReq);
        up.once('data', connResp => {
          if (connResp[1] !== 0x00) return client.end();
          sendSocks5ConnectReply(client, true);
          up.pipe(client);
          client.pipe(up);
        });
      }
    });
  });
});

srv.listen(LISTEN_PORT, '127.0.0.1', () => {
  console.log(`SOCKS5 relay listening on 127.0.0.1:${LISTEN_PORT} -> ${UPSTREAM_HOST}:${UPSTREAM_PORT}`);
});
