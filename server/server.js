// ======================================
//  server.js ― ログ強化版
// ======================================
const http = require('http');
const path = require('path');
const express = require('express');
const WebSocketServer = require('ws').Server;
const GameRoom = require('./GameRoom');

const app = express();
app.use(express.static(path.join(__dirname, '..', 'public')));

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const rooms = {};

// --- サーバログユーティリティ ---
function log(...args) {
  console.log('[Server]', ...args);
}

// --- 部屋の最終アクティブ更新用 ---
function updateRoomActive(roomId) {
  if (rooms[roomId]) {
    rooms[roomId].lastActive = Date.now();
    log(`Room:${roomId} active timestamp updated`);
  }
}

wss.on('connection', ws => {
  log('New client connected');

  ws.on('message', msg => {
    let data;
    try {
      data = JSON.parse(msg);
    } catch (e) {
      log('JSON parse error:', msg);
      return;
    }
    const { type, room: roomId, name } = data;
    log('Received message', { type, roomId, name });

    // --- 入室 ---
    if (type === 'join') {
      log(`Join request to room=${roomId}, name=${name}`);
      if (!roomId || !name) {
        ws.send(JSON.stringify({ type: 'error', message: '名前またはルームID未指定' }));
        log(`Join error: missing parameters`);
        return;
      }
      // 名前重複チェック（他ルーム含む）
      let conflict = false;
      for (const rid in rooms) {
        if (rid !== roomId && rooms[rid].players.some(p => p.name === name)) {
          conflict = true;
          break;
        }
      }
      if (conflict) {
        ws.send(JSON.stringify({ type: 'error', message: '他の部屋で同名のプレイヤーが存在します。' }));
        log(`Join error: name conflict for ${name}`);
        return;
      }

      // ルーム作成 or 取得
      let room = rooms[roomId];
      if (!room) {
        room = new GameRoom(roomId);
        rooms[roomId] = room;
        log(`Room created: ${roomId}`);
      }

      // ゲーム進行中で新規参加不可
      if (room.started && !room.getPlayer(name)) {
        ws.send(JSON.stringify({ type: 'error', message: 'ゲーム進行中のため入室不可' }));
        log(`Join error: game in progress in ${roomId}`);
        return;
      }

      // 切断済みゴーストの再接続（手札などの状態を維持）
      const ghost = room.players.find(p => p.name === name && !p.connected);
      if (ghost) {
        console.log(`[Room:${roomId}] ゴースト名（${name}）を復活`);
        ghost.conn = ws;
        ghost.connected = true;
        ws.roomId = roomId;
        ws.playerName = name;
        room.broadcastState();
        if (room.started) room.broadcastState();
        return;
      }

      // プレイヤー追加
      const res = room.addPlayer(name, ws);
      if (!res.ok) {
        ws.send(JSON.stringify({ type: 'error', message: res.error }));
        log(`Join error: ${res.error}`);
        return;
      }

      ws.roomId = roomId;
      ws.playerName = name;
      log(`Player joined: ${name} in room ${roomId}`);
      room.broadcastState();
      return;
    }

    // ルーム未存在
    const room = rooms[ws.roomId];
    if (!room) {
      log(`No such room: ${ws.roomId}`);
      return;
    }

    // --- ゲーム操作 ---
    switch (type) {
      case 'start':
        if (ws.playerName === room.players[0]?.name && !room.started) {
          log(`Start game in room ${room.roomId} by ${ws.playerName}`);
          room.startGame();
          updateRoomActive(room.roomId);
        }
        break;

      case 'reset':
        if (ws.playerName === room.players[0]?.name && !room.started) {
          log(`Reset game in room ${room.roomId} by ${ws.playerName}`);
          room.startGame();
          updateRoomActive(room.roomId);
        }
        break;

      case 'play':
        log(`Play received in room ${room.roomId} by ${ws.playerName}`, data.cards);
        room.handlePlay(ws.playerName, data.cards);
        updateRoomActive(room.roomId);
        break;

      case 'pass':
        log(`Pass received in room ${room.roomId} by ${ws.playerName}`);
        room.handlePass(ws.playerName);
        updateRoomActive(room.roomId);
        break;

      case 'dissolve':
        // ホストが解散をリクエスト
        if (room.players[0]?.name === ws.playerName) {
          log(`Dissolve room ${room.roomId} by host ${ws.playerName}`);
          // 解散フラグを立て、退出カウントを初期化
          room.deletedFlag = true;
          room.initialCount = room.players.length;
          room.exitCount = 0;
          // 参加者へ通知のみ（切断は参加者操作 or oncloseで）
          room.players.forEach(p => {
            if (p.conn && p.connected) {
              try {
                p.conn.send(JSON.stringify({ type: 'room-deleted' }));
              } catch { }
            }
          });
          log(`Room ${room.roomId} marked deleted (waiting for ${room.initialCount} exits)`);
        }
        break;
    }
  });

  ws.on('close', () => {
    const { roomId, playerName } = ws;
    if (!roomId || !rooms[roomId]) return;
    const room = rooms[roomId];
    const pl = room.getPlayer(playerName);
    if (pl) {
      pl.connected = false;
      pl.conn = null;
      log(`Client disconnected: ${playerName} from room ${roomId}`);
    }

    // 解散後フラグが立っているなら退出をカウント
    if (room.deletedFlag) {
      room.exitCount++;
      log(`Room:${roomId} exitCount ${room.exitCount}/${room.initialCount}`);
      if (room.exitCount >= room.initialCount) {
        delete rooms[roomId];
        log(`Room ${roomId} fully deleted after all exits`);
      }
      return;
    }

    // 通常動作：全員切断 → ルーム即時削除、そうでなければアクティブ更新＆状態送信
    if (room.players.every(p => !p.connected)) {
      delete rooms[roomId];
      log(`Room ${roomId} auto-deleted (all disconnected)`);
    } else {
      updateRoomActive(roomId);
      room.broadcastState();
    }
  });
});

// --- 新規追加: 定期タイムアウトチェック ---
setInterval(() => {
  const now = Date.now();
  for (const [roomId, room] of Object.entries(rooms)) {
    if (now - (room.lastActive || 0) > 5 * 60 * 1000) {
      log(`Room ${roomId} inactive for 5min → auto delete`);
      room.players.forEach(p => {
        if (p.conn && p.connected) {
          try {
            p.conn.send(JSON.stringify({ type: 'room-deleted' }));
            p.conn.close();
          } catch { }
          p.connected = false;
        }
      });
      delete rooms[roomId];
      log(`Room ${roomId} removed by timeout`);
    }
  }
}, 60 * 1000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => log(`Listening on http://localhost:${PORT}/`));
