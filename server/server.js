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
      ws.send(JSON.stringify({ type: 'error', message: '不正なJSON形式です' }));
      return;
    }
    // 入力値バリデーション
    if (!data || typeof data !== 'object') {
      log('Invalid message object:', data);
      ws.send(JSON.stringify({ type: 'error', message: '不正なデータ形式' }));
      return;
    }
    const { type, room: roomId, name } = data;
    log('Received message', { type, roomId, name });

    // type必須チェック
    if (!type || typeof type !== 'string') {
      log('Missing or invalid type field:', type);
      ws.send(JSON.stringify({ type: 'error', message: 'typeフィールドが不正です' }));
      return;
    }

    // --- 入室 ---
    if (type === 'join') {
      log(`Join request to room=${roomId}, name=${name}`);
      // ルームID・名前のバリデーション
      if (!roomId || typeof roomId !== 'string' || roomId.length > 32 || !/^[a-zA-Z0-9_-]+$/.test(roomId)) {
        ws.send(JSON.stringify({ type: 'error', message: 'ルームIDが不正です' }));
        log(`Join error: invalid roomId`, roomId);
        return;
      }
      if (!name || typeof name !== 'string' || name.length > 16 || !/^[^\s\x00-\x1F\x7F]+$/.test(name)) {
        ws.send(JSON.stringify({ type: 'error', message: '名前が不正です' }));
        log(`Join error: invalid name`, name);
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
        log(`[Room:${roomId}] ゴースト名（${name}）を復活`);
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
      ws.send(JSON.stringify({ type: 'error', message: 'ルームが存在しません' }));
      return;
    }

    // --- ゲーム操作 ---
    try {
      switch (type) {
        case 'start':
          if (ws.playerName === room.players[0]?.name && !room.started) {
            log(`Start game in room ${room.roomId} by ${ws.playerName}`);
            room.startGame();
            updateRoomActive(room.roomId);
          } else {
            log('Start game rejected: not host or already started');
          }
          break;

        case 'reset':
          if (ws.playerName === room.players[0]?.name && !room.started) {
            log(`Reset game in room ${room.roomId} by ${ws.playerName}`);
            room.startGame();
            updateRoomActive(room.roomId);
          } else {
            log('Reset game rejected: not host or already started');
          }
          break;

        case 'play':
          log(`Play received in room ${room.roomId} by ${ws.playerName}`, data.cards);
          // カードデータのバリデーション
          if (!Array.isArray(data.cards) || data.cards.length === 0 || data.cards.length > 5) {
            ws.send(JSON.stringify({ type: 'error', message: 'カードデータが不正です' }));
            log('Play error: invalid cards', data.cards);
            return;
          }
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
                } catch (e) {
                  log('Error sending room-deleted:', e);
                }
              }
            });
            log(`Room ${room.roomId} marked deleted (waiting for ${room.initialCount} exits)`);
          } else {
            log('Dissolve rejected: not host');
          }
          break;

        default:
          log('Unknown message type:', type);
          ws.send(JSON.stringify({ type: 'error', message: '不明な操作です' }));
      }
    } catch (e) {
      log('Exception in message handler:', e);
      ws.send(JSON.stringify({ type: 'error', message: 'サーバー内部エラー' }));
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
