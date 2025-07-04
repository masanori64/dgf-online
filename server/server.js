// ======================================
//  server/server.js  （2025-07 改訂）
// ======================================
const http   = require('http');
const path   = require('path');
const express = require('express');
const WebSocketServer = require('ws').Server;
const GameRoom = require('./GameRoom');

const app = express();
app.use(express.static(path.join(__dirname, '..', 'public')));

// ---------- HTTP サーバ ----------
const server = http.createServer(app);

// ---------- WebSocket ----------
const wss = new WebSocketServer({ server });

// ---------- ルーム管理 ----------
const rooms = {};  // roomId -> GameRoom

// ----- 入退室／ゲーム進行メッセージ -----
wss.on('connection', ws => {
  ws.on('message', msg => {
    let data; try{ data=JSON.parse(msg);}catch(e){return;}
    const {type} = data;

    // ----- join -----
    if (type === 'join') {
      const {room:roomId, name} = data;
      if(!roomId||!name){ ws.send(JSON.stringify({type:'error',message:'名前またはルームID未指定'})); return; }

      let room = rooms[roomId];
      if (!room) { room = new GameRoom(roomId); rooms[roomId] = room; }

      // ゲーム中に新規プレイヤーは NG（観戦は未実装）
      if (room.started && !room.getPlayer(name)) {
        ws.send(JSON.stringify({type:'error',message:'ゲーム進行中のため入室不可'})); return;
      }

      const res = room.addPlayer(name, ws);
      if (!res.ok) { ws.send(JSON.stringify({type:'error',message:res.error})); return; }

      ws.roomId = roomId;
      ws.playerName = name;
      room.broadcastState();                  // 全員へ
      if (room.started) room.sendStateToPlayer(name);  // 再接続者にのみ最新状態
      return;
    }

    // 以降はルーム必須
    const room = rooms[ws.roomId]; if(!room) return;

    // ----- start -----
    if (type === 'start') {
      const host = room.players[0]?.name;
      if (ws.playerName === host && !room.started) room.startGame();
      return;
    }

    // ----- reset -----
    if (type === 'reset') {
      const host = room.players[0]?.name;
      if (ws.playerName === host && !room.started) room.startGame();
      return;
    }

    // ----- play / pass -----
    if (type === 'play')  room.handlePlay(ws.playerName, data.cards);
    if (type === 'pass')  room.handlePass(ws.playerName);
  });

  // ----- 切断 -----
  ws.on('close', () => {
    const roomId = ws.roomId, name = ws.playerName;
    if (!roomId || !rooms[roomId]) return;

    const room = rooms[roomId];
    const pl = room.getPlayer(name);
    if (pl) { pl.connected = false; pl.conn = null; room.broadcastState(); }

    // --- 全員切断 → 5 分猶予で削除 ---
    if (room.players.every(p => !p.connected)) {
      if (!room._deleteTimer) {
        room._deleteTimer = setTimeout(() => {
          delete rooms[roomId];
          console.log(`Room ${roomId} removed after 5-minute grace.`);
        }, 5*60*1000);
      }
    } else {
      if (room._deleteTimer) {
        clearTimeout(room._deleteTimer);
        room._deleteTimer = null;
      }
    }
  });
});

// ---------- 起動 ----------
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server listening on ${PORT}`));
