// SSH tunnels for connections that reach MySQL through a bastion host, like
// SQLyog's "SSH" tab. For each tunnel a local TCP server on 127.0.0.1:<random>
// forwards every socket over one SSH session (direct-tcpip) to the database
// host/port as seen from the SSH server. mysql2 then simply connects to the
// local port.
import net from 'node:net';
import { Client } from 'ssh2';

const tunnels = new Map(); // key -> { port, close, ready: Promise }

function sshConfig(ssh) {
  const cfg = {
    host: ssh.host,
    port: Number(ssh.port) || 22,
    username: ssh.user,
    readyTimeout: 15000,
    keepaliveInterval: 15000,
  };
  if (ssh.auth === 'key') {
    cfg.privateKey = ssh.privateKey;
    if (ssh.passphrase) cfg.passphrase = ssh.passphrase;
  } else {
    cfg.password = ssh.password;
    cfg.tryKeyboard = true;
  }
  return cfg;
}

// Opens an SSH session + local forwarder. Resolves to { port, close }.
export function openTunnel(ssh, dstHost, dstPort, onClose) {
  return new Promise((resolve, reject) => {
    const client = new Client();
    let server = null;
    let settled = false;
    const sockets = new Set();

    const close = () => {
      for (const s of sockets) s.destroy();
      server?.close();
      client.end();
    };

    client.on('keyboard-interactive', (_n, _i, _l, prompts, finish) => finish(prompts.map(() => ssh.password || '')));
    client.on('ready', () => {
      server = net.createServer((sock) => {
        sockets.add(sock);
        sock.on('close', () => sockets.delete(sock));
        client.forwardOut('127.0.0.1', sock.remotePort || 0, dstHost, Number(dstPort), (err, stream) => {
          if (err) { sock.destroy(err); return; }
          sock.pipe(stream).pipe(sock);
          stream.on('error', () => sock.destroy());
          sock.on('error', () => stream.destroy());
        });
      });
      server.on('error', (e) => { if (!settled) { settled = true; close(); reject(e); } });
      server.listen(0, '127.0.0.1', () => {
        settled = true;
        resolve({ port: server.address().port, close });
      });
    });
    client.on('error', (e) => {
      const err = new Error(`SSH: ${e.level === 'client-authentication' ? 'autenticación fallida' : e.message}`);
      err.code = 'SSH_FAILED';
      if (!settled) { settled = true; reject(err); }
    });
    client.on('close', () => {
      server?.close();
      onClose?.();
    });
    try {
      client.connect(sshConfig(ssh));
    } catch (e) {
      settled = true;
      reject(Object.assign(new Error(`SSH: ${e.message}`), { code: 'SSH_FAILED' }));
    }
  });
}

// Shared tunnel per saved connection (reused by its pool).
export async function ensureTunnel(key, ssh, dstHost, dstPort, onClose) {
  if (!tunnels.has(key)) {
    const entry = {};
    entry.ready = openTunnel(ssh, dstHost, dstPort, () => {
      tunnels.delete(key);
      onClose?.();
    }).catch((e) => { tunnels.delete(key); throw e; });
    tunnels.set(key, entry);
  }
  return tunnels.get(key).ready;
}

export async function closeTunnel(key) {
  const t = tunnels.get(key);
  if (!t) return;
  tunnels.delete(key);
  try { (await t.ready).close(); } catch { /* never opened */ }
}

export async function closeAllTunnels() {
  await Promise.all([...tunnels.keys()].map(closeTunnel));
}
