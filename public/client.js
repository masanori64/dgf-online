// =================================
//  client.js  ― 完全版 2025-07
// =================================
let ws, playerName, roomId;

// --------- DOM ユーティリティ ---------
const $ = id => document.getElementById(id);

// --------- WebSocket 接続 ---------
function connect() {
  const proto = location.protocol === 'https:' ? 'wss':'ws';
  ws = new WebSocket(`${proto}://${location.host}`);
  ws.onopen = () => ws.send(JSON.stringify({type:'join', room:roomId, name:playerName}));
  ws.onmessage = e => handle(JSON.parse(e.data));
  ws.onclose   = () => setTimeout(connect,1000);   // 自動再接続
}

// --------- 初期化 ---------
window.onload = () => {
  const p = new URLSearchParams(location.search);
  playerName = p.get('name'); roomId = p.get('room');
  if(!playerName||!roomId){ location = 'index.html'; return; }
  $('roomLabel').textContent = `ルーム: ${roomId}`;
  connect();

  $('startBtn').onclick = ()=>ws.send(JSON.stringify({type:'start'}));
  $('resetBtn').onclick = ()=>ws.send(JSON.stringify({type:'reset'}));
  $('quitBtn').onclick  = ()=>location='index.html';
  $('playBtn').onclick  = playSelected;
  $('passBtn').onclick  = ()=>ws.send(JSON.stringify({type:'pass'}));
};

// --------- 手札から選択カードを送信 ---------
function playSelected(){
  const sel=[...document.querySelectorAll('.card.selected')];
  if(sel.length===0)return;
  const data=sel.map(b=>({suit:b.dataset.suit, rank:b.dataset.rank}));
  ws.send(JSON.stringify({type:'play',cards:data}));
  sel.forEach(b=>b.classList.remove('selected'));
}

// --------- 受信メッセージで画面更新 ---------
function handle(state){
  // ===== ゲーム終了画面 =====
  if(state.type==='final'){
    $('playersList').innerHTML='';
    $('fieldCards').textContent='';
    $('handSection').style.display='none';
    $('statusMsg').textContent='ゲーム終了';
    const res=$('result'); res.innerHTML='<h3>結果</h3>';
    state.ranking.forEach(r=>{
      const div=document.createElement('div');
      div.textContent=`${r.title}: ${r.name}さん`;
      res.appendChild(div);
    });
    $('resetBtn').style.display = (state.players[0].name===playerName)?'inline-block':'none';
    $('quitBtn').style.display  = (state.players[0].name===playerName)?'inline-block':'none';
    $('startBtn').style.display='none';
    return;
  }

  // ===== 待機画面 =====
  if(!state.started){
    $('startBtn').style.display =
      state.players.length>=1 && state.players[0].name===playerName ? 'inline-block':'none';
    $('resetBtn').style.display='none'; $('quitBtn').style.display='none';

    $('playersList').innerHTML = state.players.map(p=>
      `<div>${p.name}さん（入室中）</div>`).join('');
    $('fieldCards').textContent='（ゲーム待機中）';
    $('handSection').style.display='none';
    $('result').innerHTML=''; $('statusMsg').textContent='';
    return;
  }

  // ===== プレイ中画面 =====
  $('startBtn').style.display='none';   // ★ゲーム中非表示★
  $('resetBtn').style.display='none';
  $('quitBtn').style.display='none';

  // プレイヤー一覧 + ターンハイライト
  $('playersList').innerHTML = state.players.map(p=>{
    const cur = p.name===state.currentTurn ? ' style="background:#ffef99"' : '';
    const me  = p.name===playerName ? ' style="font-weight:bold"' : '';
    const sty = cur||me;
    const txt = p.finished?`${p.name}さん - 上がり`
              :`${p.name}さん - ${p.cardsCount}枚`;
    return `<div${sty}>${txt}</div>`;
  }).join('');

  // フィールド
  $('fieldCards').textContent =
    state.field.cards.length ? `場: [${state.field.cards.join(', ')}]` : '場: （なし）';

  // 手札
  const hc=$('handCards'); hc.innerHTML='';
  state.yourHand.forEach(s=>{
    const b=document.createElement('button'); b.className='card'; b.textContent=s;
    if(s==='Joker'){b.dataset.suit='J'; b.dataset.rank='16';}
    else{b.dataset.suit=s[0]; b.dataset.rank=s.slice(1);}
    b.onclick=()=>b.classList.toggle('selected');
    hc.appendChild(b);
  });
  $('handSection').style.display='block';

  // ボタン可否
  const myTurn = state.currentTurn===playerName;
  $('playBtn').disabled=!myTurn;
  $('passBtn').disabled=!myTurn || state.field.cards.length===0;

  // メッセージ
  $('statusMsg').textContent = state.revolution?'革命発生中!':'';
  $('lastAction').textContent = state.lastMove ?
    (state.lastMove.move==='pass'
      ? `${state.lastMove.player}さんがパスしました`
      : `${state.lastMove.player}さんが ${state.lastMove.cards.join(', ')} を出しました`
        +(state.lastMove.special?` (${state.lastMove.special})`:''))
    : '';
}
