// server.js
// Simple WebSocket game server for 2-player rooms.
// Uses express to serve static files (public/) and ws for WebSocket connections.

const express = require('express');
const http = require('http');
const WebSocket = require('ws');

const app = express();
app.use(express.static('public')); // optional: serve client html from public/

const PORT = process.env.PORT || 3000;
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Rooms: { roomId: { players: [ {id,nick,ws,hand} ], deck: [], discard: [], started: bool } }
const rooms = {};

// utilities
function makeId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function createDeck() {
  const suits = ['♥','♦','♣','♠'];
  const values = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];
  const d = [];
  for (const s of suits) for (const v of values) d.push({ suit: s, value: v, color: (s==='♥'||s==='♦')?'red':'black' });
  return d;
}

function shuffle(deck) {
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
}

function broadcast(roomId, msg) {
  const room = rooms[roomId];
  if (!room) return;
  for (const p of room.players) {
    if (p.ws && p.ws.readyState === WebSocket.OPEN) {
      p.ws.send(JSON.stringify(msg));
    }
  }
}

function findPlayer(room, playerId) {
  if (!room) return null;
  return room.players.find(p => p.id === playerId) || null;
}

function startGame(roomId) {
  const room = rooms[roomId];
  if (!room) return;
  room.deck = createDeck();
  shuffle(room.deck);
  room.discard = [];
  room.started = true;

  // deal 13 to each player (if possible)
  for (const p of room.players) {
    p.hand = [];
    for (let i = 0; i < 13 && room.deck.length > 0; i++) {
      p.hand.push(room.deck.pop());
    }
  }
  // put one card to discard
  if (room.deck.length > 0) {
    room.discard.push(room.deck.pop());
  }

  // choose who starts (random)
  const starterIndex = Math.random() < 0.5 ? 0 : 1;
  const starterId = room.players[starterIndex].id;

  // send 'start' to each player individually with their own hand
  for (const p of room.players) {
    const isTurn = p.id === starterId;
    p.ws.send(JSON.stringify({
      type: 'start',
      payload: {
        hand: p.hand,
        opponentCount: room.players.length - 1,
        isTurn,
        discardPile: room.discard
      }
    }));
  }

  // Also notify both that game started (optional)
  broadcast(roomId, { type: 'chat', payload: { nick: 'System', text: 'Game started' }});
}

// WebSocket connections
wss.on('connection', function connection(ws) {
  ws.on('message', function incoming(message) {
    let msg;
    try {
      msg = JSON.parse(message);
    } catch (e) {
      ws.send(JSON.stringify({ type: 'error', payload: { message: 'Invalid JSON' }}));
      return;
    }

    const { type, payload } = msg;

    if (type === 'join') {
      // payload: { room, nick, create }
      const roomId = payload.room;
      const nick = payload.nick || 'Player';
      const create = !!payload.create;

      if (!roomId) {
        ws.send(JSON.stringify({ type: 'error', payload: { message: 'Room ID လိုချင်ပါတယ်' }}));
        return;
      }

      if (!rooms[roomId]) {
        if (create) {
          rooms[roomId] = { players: [], deck: [], discard: [], started: false };
        } else {
          ws.send(JSON.stringify({ type: 'error', payload: { message: 'Room မတွေ့ပါ (create=true နဲ့ ဖန်တီးပါ)' }}));
          return;
        }
      }

      const room = rooms[roomId];
      if (room.players.length >= 2) {
        ws.send(JSON.stringify({ type: 'error', payload: { message: 'Room ပိတ်ပြီးပါပြီ (already full)' }}));
        return;
      }

      const playerId = makeId();
      ws.playerId = playerId;
      ws.roomId = roomId;
      ws.nick = nick;

      const playerObj = { id: playerId, nick, ws, hand: [] };
      room.players.push(playerObj);

      // send joined ack
      ws.send(JSON.stringify({ type: 'joined', payload: { room: roomId, id: playerId } }));

      // broadcast chat that someone joined
      broadcast(roomId, { type: 'chat', payload: { nick: 'System', text: `${nick} အခန်းထဲဝင်လာပါသည်` }});

      // If 2 players now, start game
      if (room.players.length === 2) {
        startGame(roomId);
      } else {
        // notify waiting
        ws.send(JSON.stringify({ type: 'state', payload: { opponentCount: room.players.length - 1 }}));
      }
    }

    else if (type === 'chat') {
      // payload: { room, text, nick }
      const roomId = payload.room || ws.roomId;
      const text = payload.text || '';
      const nick = payload.nick || ws.nick || 'Player';
      if (rooms[roomId]) {
        broadcast(roomId, { type: 'chat', payload: { nick, text, from: ws.playerId }});
      }
    }

    else if (type === 'draw') {
      // payload: { room, playerId }
      const roomId = payload.room || ws.roomId;
      const room = rooms[roomId];
      if (!room) return;

      const player = findPlayer(room, payload.playerId);
      if (!player) return;

      // check it's player's turn (server authoritative)
      // determine whose turn: find who has isTurn true. We will store isTurn on room as player id.
      // For simplicity: infer isTurn as lastDiscardTurn property in room.
      // We'll track room.currentTurn (playerId)
      if (!room.currentTurn) {
        // if not set (first draw before any discards), choose starter as first player in players
        room.currentTurn = room.players[0].id;
      }
      if (room.currentTurn !== player.id) {
        ws.send(JSON.stringify({ type: 'error', payload: { message: 'အခုတော့ မင်းအလှည့်မဟုတ်ပါ' }}));
        return;
      }

      if (room.deck.length === 0) {
        ws.send(JSON.stringify({ type: 'error', payload: { message: 'Deck မှာ ဖဲမရှိတော့ပါ' }}));
        return;
      }

      const card = room.deck.pop();
      player.hand.push(card);

      // broadcast deal so that client-side will push card to correct player's hand
      broadcast(roomId, { type: 'deal', payload: { to: player.id, card, discardPile: room.discard }});

      // also broadcast generic state (isTurn unchanged)
      broadcast(roomId, { type: 'state', payload: { opponentCount: room.players.length - 1, discardPile: room.discard, isTurn: room.currentTurn }});
    }

    else if (type === 'discard') {
      // payload: { room, playerId, cardIndex, card }
      const roomId = payload.room || ws.roomId;
      const room = rooms[roomId];
      if (!room) return;

      const player = findPlayer(room, payload.playerId);
      if (!player) return;

      if (!room.currentTurn) {
        room.currentTurn = room.players[0].id;
      }
      if (room.currentTurn !== player.id) {
        ws.send(JSON.stringify({ type: 'error', payload: { message: 'အခု မင်းအလှည့်မဟုတ်ပါ' }}));
        return;
      }

      const idx = parseInt(payload.cardIndex, 10);
      if (isNaN(idx) || idx < 0 || idx >= player.hand.length) {
        ws.send(JSON.stringify({ type: 'error', payload: { message: 'Invalid card index' }}));
        return;
      }

      // remove card from player's hand (server authoritative)
      const removed = player.hand.splice(idx, 1)[0];
      room.discard.push(removed);

      // switch turn to the other player (if exists)
      const other = room.players.find(p => p.id !== player.id);
      room.currentTurn = other ? other.id : null;

      // broadcast discard - include updatedHand and nextTurn
      broadcast(roomId, {
        type: 'discard',
        payload: {
          card: removed,
          updatedHand: player.hand,
          updatedHandOwner: player.id,
          nextTurn: room.currentTurn,
          discardPile: room.discard
        }
      });

      // also send generic state to sync
      broadcast(roomId, { type: 'state', payload: { isTurn: room.currentTurn, discardPile: room.discard }});

      // check win condition (player hand empty)
      if (player.hand.length === 0) {
        broadcast(roomId, { type: 'chat', payload: { nick: 'System', text: `${player.nick} အနိုင်ရပါပြီ!` }});
        room.started = false;
      }
    }

    else {
      ws.send(JSON.stringify({ type: 'error', payload: { message: 'Unknown message type' }}));
    }
  });

  ws.on('close', function() {
    const roomId = ws.roomId;
    const playerId = ws.playerId;
    if (!roomId || !rooms[roomId]) return;
    const room = rooms[roomId];
    // remove player from room
    room.players = room.players.filter(p => p.id !== playerId);
    broadcast(roomId, { type: 'chat', payload: { nick: 'System', text: `${ws.nick || 'Player'} disconnect လုပ်သွားပြီ` }});
    // if room empty, delete it
    if (room.players.length === 0) {
      delete rooms[roomId];
    } else {
      // update state for remaining player
      broadcast(roomId, { type: 'state', payload: { opponentCount: room.players.length - 1 }});
    }
  });
});

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`WebSocket available at ws(s)://<your-app> (same origin)`);
});
