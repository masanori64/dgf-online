const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const path = require("path");

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static(path.join(__dirname, "../public")));

const rooms = {};

wss.on("connection", (ws) => {
    ws.on("message", (message) => {
        const data = JSON.parse(message);
        if (data.type === "join") {
            const { roomId, name, maxPlayers } = data;
            if (!rooms[roomId]) {
                rooms[roomId] = { players: [], max: maxPlayers, started: false };
            }

            const player = { ws, name, isNPC: false, hand: [] };
            rooms[roomId].players.push(player);

            if (rooms[roomId].players.length === rooms[roomId].max) {
                startGame(roomId);
            }
        }

        if (data.type === "play") {
            console.log(`[${data.roomId}] ${data.card} を出しました`);
        }

        if (data.type === "pass") {
            console.log(`[${data.roomId}] パスしました`);
        }
    });
});

function startGame(roomId) {
    const room = rooms[roomId];
    while (room.players.length < room.max) {
        room.players.push({ name: getRandomNPC(), isNPC: true, hand: [] });
    }

    const deck = shuffleDeck();
    for (let i = 0; i < room.max; i++) {
        room.players[i].hand = deck.slice(i * 5, (i + 1) * 5);
        if (!room.players[i].isNPC) {
            room.players[i].ws.send(JSON.stringify({
                type: "hand",
                cards: room.players[i].hand,
            }));
        }
    }

    room.started = true;
}

function shuffleDeck() {
    const suits = ["♠", "♥", "♦", "♣"];
    const deck = [];
    for (let s of suits) for (let r = 3; r <= 15; r++) deck.push(`${s}${r}`);
    return deck.sort(() => Math.random() - 0.5);
}

function getRandomNPC() {
    const names = ["Taro", "Hanako", "Jiro", "Yuki", "Kei"];
    return names[Math.floor(Math.random() * names.length)];
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`http://localhost:${PORT} でサーバー起動中`);
});
