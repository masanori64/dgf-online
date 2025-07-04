// ====================================
//  GameRoom.js  ― 完全版 2025-07 修正版
// ====================================

// ---------- 基本カードクラス ----------
class Card {
    constructor(suit, rank) {
        this.suit = suit;                    // '♣','♦','♥','♠' または 'J'
        this.rank = rank;                    // 3〜15, Joker は 16
        this.isJoker = suit === 'J';
    }
    toString() {
        return this.isJoker ? 'Joker' : this.suit + Card.rankToLabel(this.rank);
    }
    static rankToLabel(r) {
        return { 11: 'J', 12: 'Q', 13: 'K', 14: 'A', 15: '2' }[r] || String(r);
    }
}

// ---------- デッキ ----------
class Deck {
    constructor(useJoker = true) {
        this.cards = [];
        const suits = ['♣', '♦', '♥', '♠'];
        const ranks = [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];
        for (const s of suits) for (const r of ranks) this.cards.push(new Card(s, r));
        if (useJoker) this.cards.push(new Card('J', 16));
    }
    shuffle() {
        for (let i = this.cards.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [this.cards[i], this.cards[j]] = [this.cards[j], this.cards[i]];
        }
    }
}

// ---------- プレイヤークラス ----------
class Player {
    constructor(name, conn = null, isNPC = false) {
        this.name = name;
        this.conn = conn;
        this.connected = !!conn;
        this.isNPC = isNPC;
        this.hand = [];
        this.finished = false;
        this.rankTitle = '';
    }
}

// ---------- ゲームルーム ----------
class GameRoom {
    constructor(roomId) {
        this.roomId = roomId;
        this.players = [];
        this.started = false;
        this.currentTurn = 0;
        this.lastPlayedCards = [];
        this.lastPlayedRank = null;
        this.lastPlayedCount = 0;
        this.lastPlayerIndex = null;
        this.passCount = 0;
        this.revolution = false;
        this.lastChampion = null;   // 都落ち用
        this.lastMoveInfo = null;   // UI 表示用
        this._deleteTimer = null;   // 全員切断後の削除タイマー
    }

    // ======= プレイヤー管理 =======
    getPlayer(name) { return this.players.find(p => p.name === name); }

    addPlayer(name, conn) {
        const exist = this.getPlayer(name);
        if (exist) {
            if (exist.connected) return { ok: false, error: '同名プレイヤーが既に接続中です。' };
            exist.conn = conn; exist.connected = true; exist.isNPC = false;
            return { ok: true, reconnect: true };
        }
        this.players.push(new Player(name, conn, false));
        return { ok: true, reconnect: false };
    }

    fillNPCPlayers() {
        while (this.players.length < 4) {
            const npcName = `NPC${this.players.length}`;
            if (!this.getPlayer(npcName)) this.players.push(new Player(npcName, null, true));
        }
    }

    // ======= ゲーム開始／再戦 =======
    startGame() {
        this.started = true;
        this.revolution = false;
        this.lastPlayedCards = []; this.lastPlayedRank = null; this.lastPlayedCount = 0;
        this.lastPlayerIndex = null; this.passCount = 0; this.lastMoveInfo = null;

        // 手札クリア
        this.players.forEach(p => { p.hand = []; p.finished = false; p.rankTitle = ''; });

        // NPC 補充
        this.fillNPCPlayers();

        // カード配布
        const deck = new Deck(true); deck.shuffle();
        let idx = 0; for (const c of deck.cards) { this.players[idx].hand.push(c); idx = (idx + 1) % this.players.length; }
        this.players.forEach(p => p.hand.sort((a, b) => a.rank - b.rank));

        // -------- スタート順：ホスト固定 ----------
        this.currentTurn = 0;

        this.broadcastState();
        this.checkAndHandleNPC();
    }

    // ======= ヘルパ =======
    getNextAlive(idx) {
        const n = this.players.length;
        let i = idx;
        do { i = (i + 1) % n; } while (this.players[i].finished);
        return i;
    }
    rankValue(card) { return card.isJoker ? 16 : card.rank; }

    // ======= 行動: play =======
    handlePlay(playerName, dataCards) {
        if (!this.started) return;
        const pl = this.getPlayer(playerName); if (!pl || pl.finished) return;
        if (this.players[this.currentTurn].name !== playerName) return;

        // ---- dataCards を手札から実体化 ----
        const played = [];
        for (const d of dataCards) {
            if (d.suit === 'J' || d.rank == 16) {
                const j = pl.hand.find(c => c.isJoker); if (!j) return; played.push(j);
            } else {
                let rankNum = typeof d.rank === 'number' ? d.rank : Number({
                    'J': 11, 'Q': 12, 'K': 13, 'A': 14, '2': 15
                }[d.rank] || d.rank);
                const idx = pl.hand.findIndex(c => !c.isJoker && c.suit === d.suit && c.rank === rankNum);
                if (idx === -1) return;
                played.push(pl.hand[idx]);
            }
        }
        if (played.length === 0) return;

        // ---- 同 rank or Joker 単独チェック ----
        const nonJ = played.filter(c => !c.isJoker);
        if (nonJ.length > 0 && new Set(nonJ.map(c => c.rank)).size > 1) return;

        // ---- 場との比較 ----
        if (this.lastPlayedCards.length > 0) {
            if (played.length !== this.lastPlayedCount) return;           // 枚数不一致
            if (this.lastPlayedRank === 16) return;                       // Joker に勝てない
            const pVal = this.rankValue(played[0]);
            const prev = this.lastPlayedRank;
            if (!this.revolution) {
                if (pVal <= prev) return;
            } else {
                if (pVal >= prev) return;
            }
        }

        // ---- 手札から除去 ----
        played.forEach(c => { const i = pl.hand.indexOf(c); if (i !== -1) pl.hand.splice(i, 1); });

        // ---- 場更新 ----
        this.lastPlayedCards = [...played];
        this.lastPlayedCount = played.length;
        this.lastPlayedRank = this.rankValue(played[0]);
        this.lastPlayerIndex = this.currentTurn;
        this.passCount = 0;

        // ---- 8切り / 革命 ----
        const eightCut = played.some(c => !c.isJoker && c.rank === 8);
        let revToggled = false;
        if (played.length >= 4 && !played[0].isJoker) {
            this.revolution = !this.revolution;
            revToggled = true;
        }

        // ---- 上がり判定 ----
        if (pl.hand.length === 0) { pl.finished = true; }

        // ---- lastMoveInfo ----
        this.lastMoveInfo = { player: pl.name, move: 'play', cards: played, special: null };
        if (eightCut) this.lastMoveInfo.special = '8切り';
        if (revToggled) this.lastMoveInfo.special = this.lastMoveInfo.special ? this.lastMoveInfo.special + '・革命' : '革命';

        // ---- ゲーム終了？ ----
        if (this.isGameOver()) { this.endGame(); this.broadcastState(); return; }

        // ---- 8切りの場流し ----
        if (eightCut) {
            this.lastPlayedCards = []; this.lastPlayedRank = null; this.lastPlayedCount = 0; this.passCount = 0;
            if (!pl.finished) { /* 同じプレイヤーがもう一度出せる */ }
            else { this.currentTurn = this.getNextAlive(this.currentTurn); }
        } else {
            this.currentTurn = this.getNextAlive(this.currentTurn);
        }

        this.broadcastState();
        this.checkAndHandleNPC();
    }

    // ======= 行動: pass =======
    handlePass(playerName) {
        if (!this.started) return;
        const pl = this.getPlayer(playerName); if (!pl || pl.finished) return;
        if (this.players[this.currentTurn].name !== playerName) return;
        if (this.lastPlayedCards.length === 0) return;   // 新規場でパス不可

        this.passCount++;
        this.lastMoveInfo = { player: pl.name, move: 'pass' };

        // 全員パス？
        const active = this.players.filter(p => !p.finished).length;
        let need;
        if (this.lastPlayerIndex !== null && !this.players[this.lastPlayerIndex].finished) {
            need = active - 1;
        } else need = active;
        if (this.passCount >= need) {
            // 場流し
            this.lastPlayedCards = []; this.lastPlayedRank = null; this.lastPlayedCount = 0; this.passCount = 0;
            this.currentTurn = (this.lastPlayerIndex !== null && !this.players[this.lastPlayerIndex].finished)
                ? this.lastPlayerIndex
                : this.getNextAlive(this.currentTurn);
            this.lastMoveInfo.special = this.lastMoveInfo.special ? this.lastMoveInfo.special + '・場流し' : '場流し';
        } else {
            this.currentTurn = this.getNextAlive(this.currentTurn);
        }

        if (this.isGameOver()) { this.endGame(); }

        this.broadcastState();
        this.checkAndHandleNPC();
    }

    // ======= 終了処理 =======
    isGameOver() { return this.started && this.players.filter(p => !p.finished).length <= 1; }

    endGame() {
        const last = this.players.find(p => !p.finished); if (last) last.finished = true;
        const ordered = [...this.players].sort((a, b) => a.hand.length - b.hand.length);
        const n = ordered.length;
        ordered.forEach((p, i) => {
            p.rankTitle = (i === 0) ? '大富豪' : (i === 1 && n >= 4) ? '富豪' : (i === n - 2 && n >= 4) ? '貧民' : (i === n - 1) ? '大貧民' : '平民';
        });
        if (this.lastChampion) {
            const champ = this.getPlayer(this.lastChampion);
            if (champ && champ.rankTitle !== '大富豪') champ.rankTitle = '大貧民';
        }
        this.lastChampion = ordered[0].name;
        this.started = false;
    }

    // ======= 状態生成 / 送信 =======
    buildState() {
        const gameOver = this.isGameOver();
        return {
            type: gameOver ? 'final' : 'update',
            room: this.roomId,
            started: this.started,
            gameOver,
            players: this.players.map(p => ({
                name: p.name, cardsCount: p.hand.length, finished: p.finished, connected: p.connected || p.isNPC
            })),
            field: { cards: this.lastPlayedCards.map(c => c.toString()) },
            currentTurn: this.started ? this.players[this.currentTurn].name : null,
            revolution: this.revolution,
            ranking: gameOver ? this.players.map(p => ({ name: p.name, title: p.rankTitle })) : null,
            lastMove: this.lastMoveInfo ? {
                ...this.lastMoveInfo,
                cards: this.lastMoveInfo.cards?.map(c => c.toString())
            } : null
        };
    }

    broadcastState() {
        const st = this.buildState();
        this.players.forEach(p => {
            if (p.conn && p.connected) {
                p.conn.send(JSON.stringify({ ...st, yourHand: p.hand.map(c => c.toString()) }));
            }
        });
    }
    sendStateToPlayer(name) {
        const p = this.getPlayer(name); if (p && p.conn && p.connected) {
            const st = this.buildState();
            p.conn.send(JSON.stringify({ ...st, yourHand: p.hand.map(c => c.toString()) }));
        }
    }

    // ======= NPC =======
    checkAndHandleNPC() {
        if (!this.started) return;
        const cur = this.players[this.currentTurn];
        if (cur && cur.isNPC && !cur.finished) {
            setTimeout(() => this.npcAction(cur), 500);
        }
    }
    npcAction(pl) {
        if (pl.finished) return;
        // シンプル戦略: 出せる最小カード、無ければパス
        let play = null;

        const canBeat = (rank) => {
            if (this.lastPlayedCards.length === 0) return true;
            const prev = this.lastPlayedRank;
            if (this.revolution) return rank < prev;
            return rank > prev;
        };

        // シングル or 場と同枚数
        if (this.lastPlayedCards.length === 0) {
            play = [pl.hand[0]];
        } else {
            const need = this.lastPlayedCount;
            const groups = {}; pl.hand.forEach(c => {
                if (c.isJoker) return;
                if (!groups[c.rank]) groups[c.rank] = [];
                groups[c.rank].push(c);
            });
            Object.entries(groups).forEach(([r, cards]) => {
                if (cards.length >= need && !play) {
                    if (canBeat(+r)) {
                        play = cards.slice(0, need);
                    }
                }
            });
            if (!play) {
                const joker = pl.hand.find(c => c.isJoker);
                if (joker && need === 1 && canBeat(16)) play = [joker];
            }
        }

        if (play) { this.handlePlay(pl.name, play.map(c => ({ suit: c.suit, rank: c.rank }))); }
        else { this.handlePass(pl.name); }
    }
}

module.exports = GameRoom;
