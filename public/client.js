// =================================
//  client.js ― 保守性・可読性・ログ・UI制御強化版＋再読み込み対策
// =================================

console.log('[Client] script loaded');

// --------- リロード判別フラグ ---------
let isReloading = false;
window.addEventListener('beforeunload', () => {
    isReloading = true;
});

// --------- 部屋解散判別フラグ ---------
let roomDeletedReceived = false;

// --------- DOMユーティリティ ---------
const $ = id => document.getElementById(id);
const EL = {
    app: 'app',
    roomLabel: 'roomLabel',
    playersList: 'playersList',
    fieldCards: 'fieldCards',
    statusMsg: 'statusMsg',
    handSection: 'handSection',
    handCards: 'handCards',
    result: 'result',
    footerControls: 'footerControls',
    startBtn: 'startBtn',
    resetBtn: 'resetBtn',
    quitBtn: 'quitBtn',
    leaveBtn: 'leaveBtn',
    playBtn: 'playBtn',
    passBtn: 'passBtn',
    whiteOverlay: 'white-overlay',
};
function getEl(key) { return $(EL[key]); }
function setDisplay(key, show, style = 'inline-block') {
    const el = getEl(key);
    if (el) el.style.display = show ? style : 'none';
}

// --------- ランク変換ユーティリティ ---------
function parseRank(r) {
    switch (r) {
        case 'J': return 11;
        case 'Q': return 12;
        case 'K': return 13;
        case 'A': return 14;
        case '2': return 15;
        default: return Number(r);
    }
}

// --------- アプリ全体状態 ---------
const App = {
    ws: null,
    playerName: '',
    roomId: '',
    finalStateKey: 'finalState',
    log: (...args) => console.log('[Client]', ...args),
    shown: false,
};

// --------- 初期化 ---------
window.onload = () => init();

function init() {
    App.log('init start');

    // ── 初回起動かリロード再読み込みかを判別
    const isReload = sessionStorage.getItem('reloaded') === 'true';
    sessionStorage.setItem('reloaded', 'true');

    if (!isReload) {
        // 初回起動：フラグ＆結果をクリアして通常ルートへ
        localStorage.removeItem('roomDeletedFlag');
        localStorage.removeItem(App.finalStateKey);
        App.log('init: first load, cleared flags');
    } else {
        // リロード時：解散フラグと finalState を復元ルートで利用
        App.log('init: reload detected');
        const wasDeleted = localStorage.getItem('roomDeletedFlag') === 'true';
        const last = JSON.parse(localStorage.getItem(App.finalStateKey) || 'null');
        if (wasDeleted && last && last.type === 'final') {
            App.log('init: room was deleted, restoring finalState');
            render(last);
            // 終了時と同じコントロール表示
            const isHost = last.players[0]?.name === App.playerName;
            setDisplay('resetBtn', isHost);
            setDisplay('quitBtn', isHost);
            setDisplay('startBtn', false);
            setDisplay('leaveBtn', !isHost);
            // ── ここでも「退出」ボタンのハンドラを必ず設定
            getEl('leaveBtn').onclick = () => {
                sessionStorage.removeItem('reloaded');
                location.href = 'index.html';
            };
            return;
        }
    }

    // URL パラメータ取得
    const p = new URLSearchParams(location.search);
    App.playerName = p.get('name') || '';
    App.roomId = p.get('room') || '';
    App.log('params', { name: App.playerName, room: App.roomId });
    if (!App.playerName || !App.roomId) {
        location.href = 'index.html';
        return;
    }
    getEl('roomLabel').textContent = `ルーム: ${App.roomId}`;

    // ボタンイベント登録
    getEl('startBtn').onclick = () => {
        localStorage.removeItem(App.finalStateKey);
        App.log('action.start');
        App.ws?.send(JSON.stringify({ type: 'start' }));
    };
    getEl('resetBtn').onclick = () => {
        localStorage.removeItem(App.finalStateKey);
        App.log('action.reset');
        App.ws?.send(JSON.stringify({ type: 'reset' }));
    };
    getEl('quitBtn').onclick = () => {
        App.log('action.dissolve');
        App.ws?.send(JSON.stringify({ type: 'dissolve' }));
        showOverlay('ルームを解散しました。');
    };
    getEl('playBtn').onclick = playSelected;
    getEl('passBtn').onclick = () => {
        App.log('action.pass');
        App.ws?.send(JSON.stringify({ type: 'pass' }));
    };
    getEl('leaveBtn').onclick = () => {
        // リロード判定フラグもクリアして、再度入室時には初回扱いに戻す
        sessionStorage.removeItem('reloaded');
        localStorage.removeItem(App.finalStateKey);
        location.href = 'index.html';
    };

    // WebSocket 接続
    connect();
}

// --------- WebSocket 接続・ハンドラ ---------
function connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    App.log('ws.connect', `${proto}://${location.host}`);
    App.ws = new WebSocket(`${proto}://${location.host}`);

    App.ws.onopen = () => {
        App.log('ws.open → join', { room: App.roomId, name: App.playerName });
        App.ws.send(JSON.stringify({
            type: 'join',
            room: App.roomId,
            name: App.playerName,
            mode: 'create'
        }));
    };

    App.ws.onmessage = msg => {
        const data = JSON.parse(msg.data);
        // ここで受信データを全ログ
        App.log('ws.onmessage', {
            type: data.type,
            started: data.started,
            yourHand: data.yourHand,
            fieldCards: data.field?.cards
        });

        // ── 通常の 'update' メッセージ受信時のみ stale な finalState を消去
        if (data.type === 'update') {
            localStorage.removeItem(App.finalStateKey);
        }

        if (data.type === 'room-deleted') {
            roomDeletedReceived = true;
            // 永続化して, リロード後も結果復元ルートに入れるように
            localStorage.setItem('roomDeletedFlag', 'true');
            const isHost = getEl('resetBtn').style.display === 'inline-block'
                || getEl('quitBtn').style.display === 'inline-block';
            if (isHost) {
                // ホストは即リダイレクト
                location.href = 'index.html';
            }
            // 参加者は何もしない（結果画面維持）
            return;
        }

        if (data.type === 'error') {
            App.log('ws.error', data.message);
            showOverlay(data.message || 'エラーが発生しました。');
            return;
        }
        // 終了時のみ finalState に保存
        if (data.type === 'final' || data.gameOver || data.ranking?.length > 0) {
            localStorage.setItem(App.finalStateKey, JSON.stringify(data));
        }

        App.log('before render', { type: data.type });
        render(data);
        App.log('after render', {
            handSectionVisible: getEl('handSection').style.display,
            handButtonsCount: document.querySelectorAll('.card').length
        });
    };

    App.ws.onclose = () => {
        App.log('ws.close');
        // ① リロード時は何もしない（再接続ルートへ）
        if (isReloading) {
            App.log('reload detected, skip onclose');
            return;
        }
        // ② 部屋解散後の切断なら何もしない（結果画面を維持）
        if (roomDeletedReceived) {
            App.log('room-deleted detected, skip onclose');
            return;
        }
        // ③ 通常切断時：結果があれば再描画、なければトップへ
        const last = JSON.parse(localStorage.getItem(App.finalStateKey) || 'null');
        if (last) {
            render(last);
            setDisplay('footerControls', true);
            return;
        }
        showOverlay('サーバーとの接続が切れました。');
    };
}

// --------- オーバーレイ+アラート ---------
function showOverlay(msg) {
    let ov = getEl('whiteOverlay');
    if (!ov) {
        ov = document.createElement('div');
        ov.id = EL.whiteOverlay;
        Object.assign(ov.style, {
            position: 'fixed', top: 0, left: 0,
            width: '100vw', height: '100vh',
            background: '#fff', zIndex: 9999
        });
        document.body.appendChild(ov);
    }
    ov.style.display = 'block';
    setTimeout(() => { alert(msg); location.href = 'index.html'; }, 10);
}

// --------- カード出し ---------
function playSelected() {
    const sel = [...document.querySelectorAll('.card-img.selected')];
    if (!sel.length) return;
    const cards = sel.map(b => ({
        suit: b.dataset.suit,
        rank: parseRank(b.dataset.rank)
    }));
    App.log('action.play', cards);
    App.ws.send(JSON.stringify({ type: 'play', cards }));
    sel.forEach(b => b.classList.remove('selected'));
}
// --------- UI 描画 ---------

window.addEventListener('DOMContentLoaded', () => {
    showWaitingDecorations();
});

// ✅ スタートボタンを押したら装飾を隠す
document.querySelector('.js-start-btn')?.addEventListener('click', () => {
    hideWaitingDecorations();
});

function render(state) {
    // 初回描画後に #app を可視化
    if (!App.shown) {
        getEl('app').style.visibility = 'visible';
        App.shown = true;
    }

    // 全画面共通で先にこれらを非表示
    ['result', 'footerControls', 'playersList'].forEach(k => setDisplay(k, false));

    // ✅ タイトルの表示・非表示制御（簡潔に統一）
    const h1 = document.querySelector('h1');
    if (h1) {
        h1.textContent = '大富豪オンライン';
        h1.style.textAlign = 'left';
        h1.style.display = state.started ? 'none' : 'block';
    }

    // ── 終了画面 ──
    if (state.type === 'final') {
        getEl('roomLabel').textContent = `ルーム: ${state.room}`;
        setDisplay('handSection', false);
        setDisplay('playersList', false);
        setDisplay('fieldCards', false);
        getEl('statusMsg').textContent = 'ゲーム終了';

        const res = getEl('result');
        res.innerHTML = '<h3>結果</h3>';
        state.ranking.forEach(r => {
            const d = document.createElement('div');
            d.textContent = `${r.rank}位: ${r.name}さん`;
            res.appendChild(d);
        });

        const isHost = state.players[0]?.name === App.playerName;
        setDisplay('resetBtn', isHost);
        setDisplay('quitBtn', isHost);
        setDisplay('leaveBtn', !isHost);

        setDisplay('result', true);
        setDisplay('footerControls', true);
        return;
    }

    // ── 待機中 ──
    if (!state.started) {
        const canStart = state.players[0]?.name === App.playerName && state.players.length >= 2;
        setDisplay('startBtn', canStart);
        ['resetBtn', 'quitBtn'].forEach(k => setDisplay(k, false));
        setDisplay('leaveBtn', true);

        getEl('playersList').innerHTML = state.players
            .map(p => `<div>${p.name}さん（入室中）</div>`).join('');
        getEl('fieldCards').textContent = '（ゲーム待機中）';
        setDisplay('handSection', false);
        getEl('statusMsg').textContent = '';
        getEl('result').innerHTML = '';

        setDisplay('footerControls', true);
        setDisplay('playersList', true);
        return;
    }

    // ── ゲーム中 ──
    ['startBtn', 'resetBtn', 'quitBtn', 'leaveBtn', 'footerControls', 'result'].forEach(k => setDisplay(k, false));
    setDisplay('playersList', true);

    // プレイヤーリスト
    getEl('playersList').innerHTML = state.players.map(p => {
        const cur = p.name === state.currentTurn;
        const me = p.name === App.playerName;
        return `<div${cur ? ' class="current-turn"' : ''}${me ? ' style="font-weight:bold"' : ''}>`
            + (p.finished
                ? `${p.name}さん - 上がり`
                : `${p.name}さん - ${p.cardsCount}枚`)
            + `</div>`;
    }).join('');

  // 場
const fc = getEl('fieldCards');
fc.innerHTML = '';
if (state.field.cards.length) {
    state.field.cards.forEach(s => {
        const m = s.match(/^([♣♦♥♠])([0-9JQKA]+)$/);
        if (!m) return;

        const suit = m[1];
        const rank = m[2];
        const code = suitToCode(suit) + rank;

        const img = document.createElement('img');
        img.className = 'fieldcard';  // CSSで別表示したい場合
        img.src = `images/cards/${code}.png`;
        img.alt = code;
        img.dataset.suit = suit;
        img.dataset.rank = rank;

        fc.appendChild(img);
    });
} else {
    fc.textContent = '場　なし';
}


    // 手札
const hc = getEl('handCards');
hc.innerHTML = '';
state.yourHand.forEach(s => {
    const m = s.match(/^([♣♦♥♠])([0-9JQKA]+)$/);
    if (!m) return;

    const suit = m[1];
    const rank = m[2];

    const code = suitToCode(suit) + rank; // 例: "S1", "H10"など

    const img = document.createElement('img');
    img.className = 'card-img';
    img.src = `images/cards/${code}.png`;
    img.alt = code;
    img.dataset.suit = suit;
    img.dataset.rank = rank;
    img.onclick = () => img.classList.toggle('selected');

    hc.appendChild(img);
});

setDisplay('handSection', true);

// 絵札の記号→頭文字コード（S, H, D, C）
function suitToCode(suit) {
    switch (suit) {
        case '♠': return 'S';
        case '♥': return 'H';
        case '♦': return 'D';
        case '♣': return 'C';
    }
}

    // ボタン活性
    const myTurn = state.currentTurn === App.playerName;
    getEl('playBtn').disabled = !myTurn;
    getEl('passBtn').disabled = !myTurn || state.field.cards.length === 0;
}
