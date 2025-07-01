const params = new URLSearchParams(location.search);
const roomId = params.get("room");
const name = params.get("name");
const maxPlayers = parseInt(params.get("max"), 10);

const socket = new WebSocket(`ws://${location.host}`);

socket.addEventListener('open', () => {
    socket.send(JSON.stringify({ type: 'join', roomId, name, maxPlayers }));
    document.getElementById("playerNameDisplay").innerText = `${name} さんの手札`;
});

socket.addEventListener('message', (event) => {
    const data = JSON.parse(event.data);
    if (data.type === "hand") {
        document.getElementById("handCards").innerText = data.cards.join(", ");
    }
});

function playCard() {
    socket.send(JSON.stringify({ type: "play", card: "♠3", roomId }));
}

function pass() {
    socket.send(JSON.stringify({ type: "pass", roomId }));
}
