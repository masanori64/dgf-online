// ====================================
//  GameRoom.js ― ログ強化版
// ====================================

// ログユーティリティ
function log(roomId, ...args) {
    console.log(`[Room:${roomId}]`, ...args);
}

class Card {
    constructor(suit, rank) {
        this.suit = suit;
        this.rank = rank;
    }
    toString() {
        return this.suit + (this.rank >= 11
            ? ['J', 'Q', 'K', 'A', '2'][this.rank - 11]
            : this.rank);
    }
}

class Deck {
    constructor() {
        this.cards = [];
        const suits = ['♣', '♦', '♥', '♠'];
        for (const s of suits) {
            for (let r = 3; r <= 15; r++) {
                this.cards.push(new Card(s, r));
            }
        }
    }
    shuffle() {
        for (let i = this.cards.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [this.cards[i], this.cards[j]] = [this.cards[j], this.cards[i]];
        }
    }
}

class Player {
    constructor(name, conn) {
        this.name = name;
        this.conn = conn;
        this.hand = [];
        this.finished = false;
        this.connected = true;
        this.rank = null;
    }
}

class GameRoom {
    constructor(roomId) {
        this.roomId = roomId;
        this.players = [];
        this.started = false;
        this.currentTurn = 0;
        this.lastPlayed = [];
        this.lastPlayedCount = 0;
        this.lastPlayedRank = null;
        this.lastPlayerIndex = null;
        this.passCount = 0;
        this.rankings = [];
        this.passedThisTurn = [];
        this.lastActive = Date.now();
        log(this.roomId, 'GameRoom created');
    }

    getPlayer(name) {
        return this.players.find(p => p.name === name);
    }

    addPlayer(name, conn) {
        if (!name || typeof name !== "string" || !conn) {
            log(this.roomId, 'addPlayer failed: invalid arguments');
            return { ok: false, error: "不正な参加" };
        }
        if (this.getPlayer(name)) {
            log(this.roomId, 'addPlayer failed: name exists', name);
            return { ok: false, error: '同名プレイヤーが既に参加中です。' };
        }
        this.players.push(new Player(name, conn));
        log(this.roomId, 'player added', name);
        return { ok: true };
    }

    startGame() {
        log(this.roomId, 'startGame invoked');
        if (this.players.length < 2) {
            log(this.roomId, 'startGame aborted: not enough players');
            return;
        }
        this.started = true;
        this.lastPlayed = [];
        this.lastPlayedCount = 0;
        this.lastPlayedRank = null;
        this.lastPlayerIndex = null;
        this.passCount = 0;
        this.rankings = [];
        this.passedThisTurn = [];
        this.players.forEach(p => {
            p.hand = [];
            p.finished = false;
            p.rank = null;
            p.connected = !!p.conn;
        });
        const deck = new Deck();
        deck.shuffle();
        let idx = 0;
        for (const c of deck.cards) {
            this.players[idx].hand.push(c);
            idx = (idx + 1) % this.players.length;
        }
        this.players.forEach(p => p.hand.sort((a, b) => a.rank - b.rank));
        this.currentTurn = this.players.findIndex(p => !p.finished);
        log(this.roomId, 'hands dealt');
        this.broadcastState();
    }

    getNextAlive(idx) {
        const n = this.players.length;
        let i = idx, safety = 0;
        do {
            i = (i + 1) % n;
            safety++;
        } while (
            (this.players[i].finished ||
                !this.players[i].connected ||
                this.passedThisTurn.includes(this.players[i].name))
            && safety < n * 2
        );
        return i;
    }

    isPlayable(hand, dataCards) {
        if (!Array.isArray(dataCards) || dataCards.length === 0) return false;
        const rank = dataCards[0].rank;
        if (!dataCards.every(c => c.rank === rank)) return false;
        if (this.lastPlayed.length === 0) return true;
        if (dataCards.length !== this.lastPlayedCount) return false;
        if (rank <= this.lastPlayedRank) return false;
        return true;
    }

    handlePlay(playerName, dataCards) {
        log(this.roomId, 'handlePlay start', playerName, dataCards);
        if (!this.started || this.isGameOver()) return;
        const pl = this.getPlayer(playerName);
        if (!pl || pl.finished || this.players[this.currentTurn].name !== playerName) {
            log(this.roomId, 'handlePlay aborted: invalid turn or player');
            return;
        }
        if (this.passedThisTurn.includes(playerName) || !this.isPlayable(pl.hand, dataCards)) {
            log(this.roomId, 'handlePlay aborted: not playable');
            return;
        }
        // カードを手札から削除
        for (const d of dataCards) {
            const idx = pl.hand.findIndex(c => c.suit === d.suit && c.rank === d.rank);
            if (idx !== -1) pl.hand.splice(idx, 1);
        }
        this.lastPlayed = dataCards.map(c => new Card(c.suit, c.rank));
        this.lastPlayedCount = dataCards.length;
        this.lastPlayedRank = dataCards[0].rank;
        this.lastPlayerIndex = this.currentTurn;
        this.passCount = 0;
        this.passedThisTurn = [];
        log(this.roomId, `${playerName} played`, this.lastPlayed.map(c => c.toString()));
        log(this.roomId, 'remaining hand count', pl.hand.length);

        if (pl.hand.length === 0 && !pl.finished) {
            pl.finished = true;
            pl.rank = this.rankings.length + 1;
            this.rankings.push(pl);
            log(this.roomId, `${playerName} finished with rank ${pl.rank}`);
        }

        if (this.isGameOver()) {
            this.finishGame();
        } else {
            this.currentTurn = this.getNextAlive(this.currentTurn);
            log(this.roomId, 'next turn', this.players[this.currentTurn]?.name);
            this.broadcastState();
        }
    }

    handlePass(playerName) {
        log(this.roomId, 'handlePass', playerName);
        if (!this.started || this.isGameOver()) return;
        const pl = this.getPlayer(playerName);
        if (!pl || pl.finished || this.players[this.currentTurn].name !== playerName) return;
        if (this.lastPlayed.length === 0 || this.passedThisTurn.includes(playerName)) return;

        this.passedThisTurn.push(playerName);
        this.passCount++;
        log(this.roomId, `${playerName} passed`);

        const aliveCount = this.players.filter(p => !p.finished && p.connected && !this.passedThisTurn.includes(p.name)).length;
        const needed = this.players.filter(p => !p.finished && p.connected).length - 1;
        if (aliveCount === 0 || this.passCount >= needed) {
            // 場流し
            log(this.roomId, 'field cleared');
            this.lastPlayed = [];
            this.lastPlayedCount = 0;
            this.lastPlayedRank = null;
            this.passCount = 0;
            this.passedThisTurn = [];
            let nextIdx = this.lastPlayerIndex ?? this.currentTurn;
            if (this.players[nextIdx].finished || !this.players[nextIdx].connected) {
                nextIdx = this.getNextAlive(nextIdx);
            }
            this.currentTurn = nextIdx;
            log(this.roomId, 'next turn after clear', this.players[this.currentTurn]?.name);
        } else {
            this.currentTurn = this.getNextAlive(this.currentTurn);
            log(this.roomId, 'next turn after pass', this.players[this.currentTurn]?.name);
        }

        if (this.isGameOver()) {
            this.finishGame();
        } else {
            this.broadcastState();
        }
    }

    isGameOver() {
        const remain = this.players.filter(p => !p.finished && p.connected);
        return this.started && remain.length <= 1;
    }

    finishGame() {
        log(this.roomId, 'finishGame');
        const last = this.players.find(p => !p.finished && p.connected);
        if (last) {
            last.finished = true;
            last.rank = this.rankings.length + 1;
            this.rankings.push(last);
            log(this.roomId, `${last.name} last finish with rank ${last.rank}`);
        }
        this.started = false;
        this.broadcastState();
    }

    buildState() {
        const gameOver = !this.started && this.rankings.length === this.players.length;
        return {
            type: gameOver ? 'final' : 'update',
            room: this.roomId,
            started: this.started,
            gameOver,
            players: this.players.map(p => ({
                name: p.name,
                cardsCount: p.hand.length,
                finished: p.finished,
                rank: p.rank
            })),
            field: { cards: this.lastPlayed.map(c => c.toString()) },
            currentTurn: this.started ? this.players[this.currentTurn]?.name : null,
            ranking: gameOver
                ? this.rankings.map((p, i) => ({ name: p.name, rank: i + 1 }))
                : null
        };
    }

    broadcastState() {
        this.players.forEach(p => {
            if (p.conn && p.connected) {
                p.conn.send(JSON.stringify({
                    ...this.buildState(),
                    yourHand: p.hand.map(c => c.toString())
                }));
            }
        });
    }
}

module.exports = GameRoom;
