const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.static('public'));

// Хранилище лобби
const lobbies = new Map();
const socketLobby = new Map();

function genCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 5; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return lobbies.has(code) ? genCode() : code;
}

function getLobbyPayload(lobby) {
  return {
    code: lobby.code,
    host: lobby.host,
    limit: lobby.limit,
    players: [...lobby.players.values()].map(p => ({
      id: p.id,
      n: p.n,
      k: p.k,
      d: p.d
    }))
  };
}

function leaveCurrentLobby(socket) {
  const code = socketLobby.get(socket.id);
  if (!code) return;

  const lobby = lobbies.get(code);
  socketLobby.delete(socket.id);
  socket.leave(code);

  if (!lobby) return;

  lobby.players.delete(socket.id);
  socket.to(code).emit('p:left', socket.id);

  if (lobby.players.size === 0) {
    lobbies.delete(code);
    return;
  }

  if (lobby.host === socket.id) {
    lobby.host = lobby.players.keys().next().value;
  }

  io.to(code).emit('lobby', getLobbyPayload(lobby));
}

io.on('connection', (socket) => {
  // Создание лобби
  socket.on('lobby:create', ({ name }, ack) => {
    leaveCurrentLobby(socket);
    const code = genCode();
    const lobby = {
      code,
      host: socket.id,
      limit: 20,
      inGame: false,
      players: new Map()
    };

    lobby.players.set(socket.id, {
      id: socket.id,
      n: name || 'Игрок',
      k: 0,
      d: 0,
      hp: 100
    });

    lobbies.set(code, lobby);
    socketLobby.set(socket.id, code);
    socket.join(code);

    // ОБЯЗАТЕЛЬНО: подтверждаем клиенту успешное создание
    if (typeof ack === 'function') {
      ack({ ok: true, code });
    }
    socket.emit('lobby', getLobbyPayload(lobby));
  });

  // Вход по коду
  socket.on('lobby:join', ({ code, name }, ack) => {
    leaveCurrentLobby(socket);
    const cleanCode = (code || '').trim().toUpperCase();
    const lobby = lobbies.get(cleanCode);

    if (!lobby) {
      if (typeof ack === 'function') ack({ ok: false, err: 'Лобби не найдено' });
      return;
    }

    if (lobby.inGame) {
      if (typeof ack === 'function') ack({ ok: false, err: 'Игра уже началась' });
      return;
    }

    lobby.players.set(socket.id, {
      id: socket.id,
      n: name || 'Игрок',
      k: 0,
      d: 0,
      hp: 100
    });

    socketLobby.set(socket.id, cleanCode);
    socket.join(cleanCode);

    if (typeof ack === 'function') ack({ ok: true });
    io.to(cleanCode).emit('lobby', getLobbyPayload(lobby));
  });

  socket.on('lobby:leave', () => {
    leaveCurrentLobby(socket);
  });

  socket.on('lobby:start', () => {
    const code = socketLobby.get(socket.id);
    const lobby = lobbies.get(code);
    if (!lobby || lobby.host !== socket.id) return;

    lobby.inGame = true;
    for (const p of lobby.players.values()) {
      p.k = 0;
      p.d = 0;
      p.hp = 100;
    }
    io.to(code).emit('game:start', getLobbyPayload(lobby));
  });

  socket.on('p:s', (data) => {
    const code = socketLobby.get(socket.id);
    if (code) socket.to(code).emit('p:s', socket.id, data);
  });

  socket.on('p:f', (weapon) => {
    const code = socketLobby.get(socket.id);
    if (code) socket.to(code).emit('p:f', socket.id, weapon);
  });

  socket.on('p:r', (pos) => {
    const code = socketLobby.get(socket.id);
    const lobby = lobbies.get(code);
    if (lobby && lobby.players.has(socket.id)) {
      lobby.players.get(socket.id).hp = 100;
      socket.to(code).emit('p:r', socket.id, pos);
    }
  });

  socket.on('p:h', ({ to, d, hs, w }) => {
    const code = socketLobby.get(socket.id);
    const lobby = lobbies.get(code);
    if (!lobby) return;

    const victim = lobby.players.get(to);
    const killer = lobby.players.get(socket.id);
    if (!victim || !killer) return;

    victim.hp = Math.max(0, victim.hp - d);
    io.to(code).emit('p:hp', to, victim.hp);

    if (victim.hp === 0) {
      victim.d++;
      killer.k++;
      const board = [...lobby.players.values()].map(p => ({ id: p.id, k: p.k, d: p.d }));
      io.to(code).emit('p:k', { k: killer.id, v: victim.id, w: w || 'Оружие', board });

      if (killer.k >= lobby.limit) {
        lobby.inGame = false;
        io.to(code).emit('game:end', { win: killer.id, board });
      }
    }
  });

  socket.on('disconnect', () => {
    leaveCurrentLobby(socket);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Сервер STEEL VANGUARD запущен на http://localhost:${PORT}`);
});