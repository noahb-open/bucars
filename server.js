const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

// Serve our index.html file
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// In-memory data store for lobbies
// Structure: { [lobbyCode]: { players: [{id, name, hand:[]}], deck: [], discardPile: [], currentTurn: 0, direction: 1, active: false } }
const lobbies = {};

// Helper functions for Uno logic
function generateLobbyCode() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    let code = '';
    for (let i = 0; i < 4; i++) {
        code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return lobbies[code] ? generateLobbyCode() : code; // Ensure uniqueness
}

function createUnoDeck() {
    const colors = ['Red', 'Blue', 'Green', 'Yellow'];
    const types = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', 'Skip', 'Reverse', '+2'];
    let deck = [];

    colors.forEach(color => {
        types.forEach(type => {
            // Basic Uno rule: One '0' per color, two of everything else
            let count = type === '0' ? 1 : 2;
            for (let i = 0; i < count; i++) {
                deck.push({ color, type, label: `${color} ${type}` });
            }
        });
    });

    // Shuffle deck
    for (let i = deck.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [deck[i], deck[j]] = [deck[j], deck[i]];
    }
    return deck;
}

function advanceTurn(lobby, skipCount = 1) {
    const pCount = lobby.players.length;
    // Multiplied by direction (1 for forward, -1 for backward)
    lobby.currentTurn = (lobby.currentTurn + (skipCount * lobby.direction) + pCount * skipCount) % pCount;
}

// Socket.io Real-time connection management
io.on('connection', (socket) => {
    console.log(`User connected: ${socket.id}`);

    // Create Room Handler
    socket.on('createRoom', ({ username }) => {
        if (!username) return socket.emit('errorMsg', 'Username required');
        
        const code = generateLobbyCode();
        lobbies[code] = {
            players: [{ id: socket.id, name: username, hand: [] }],
            deck: [],
            discardPile: [],
            currentTurn: 0,
            direction: 1, // 1 = Clockwise, -1 = Counter-Clockwise
            gameStarted: false
        };

        socket.join(code);
        socket.emit('roomCreated', { code, players: lobbies[code].players });
    });

    // Join Room Handler
    socket.on('joinRoom', ({ username, code }) => {
        const cleanCode = code.toUpperCase().trim();
        const lobby = lobbies[cleanCode];

        if (!lobby) return socket.emit('errorMsg', 'Lobby code not found');
        if (lobby.gameStarted) return socket.emit('errorMsg', 'Game has already started');
        if (!username) return socket.emit('errorMsg', 'Username required');

        lobby.players.push({ id: socket.id, name: username, hand: [] });
        socket.join(cleanCode);

        io.to(cleanCode).emit('roomUpdated', { players: lobby.players });
        socket.emit('roomJoined', { code: cleanCode, players: lobby.players });
    });

    // Start Game Handler
    socket.on('startGame', ({ code }) => {
        const lobby = lobbies[code];
        if (!lobby || lobby.players.length < 2) return socket.emit('errorMsg', 'Need at least 2 players to start');

        lobby.gameStarted = true;
        lobby.deck = createUnoDeck();
        
        // Deal 7 cards to each player
        lobby.players.forEach(player => {
            player.hand = lobby.deck.splice(0, 7);
        });

        // Setup the discard pile with a non-action starting card if possible
        let startCard = lobby.deck.pop();
        while (['Skip', 'Reverse', '+2'].includes(startCard.type)) {
            lobby.deck.unshift(startCard);
            startCard = lobby.deck.pop();
        }
        lobby.discardPile.push(startCard);

        io.to(code).emit('gameStarted', {
            players: lobby.players.map(p => ({ id: p.id, name: p.name, cardCount: p.hand.length })),
            topCard: startCard,
            currentTurn: lobby.currentTurn
        });

        // Send private individual hands to each user socket
        lobby.players.forEach(player => {
            io.to(player.id).emit('yourHand', player.hand);
        });
    });

    // Draw Card Handler
    socket.on('drawCard', ({ code }) => {
        const lobby = lobbies[code];
        if (!lobby) return;

        const currentPlayer = lobby.players[lobby.currentTurn];
        if (currentPlayer.id !== socket.id) return socket.emit('errorMsg', "It's not your turn!");

        // Reshuffle discard pile if main deck is empty
        if (lobby.deck.length === 0) {
            const topCard = lobby.discardPile.pop();
            lobby.deck = lobby.discardPile;
            lobby.discardPile = [topCard];
            // Quick reshuffle
            lobby.deck.sort(() => Math.random() - 0.5);
        }

        const drawnCard = lobby.deck.pop();
        currentPlayer.hand.push(drawnCard);

        advanceTurn(lobby);

        io.to(code).emit('gameUpdated', {
            players: lobby.players.map(p => ({ id: p.id, name: p.name, cardCount: p.hand.length })),
            topCard: lobby.discardPile[lobby.discardPile.length - 1],
            currentTurn: lobby.currentTurn
        });

        // Update hands privately
        lobby.players.forEach(p => io.to(p.id).emit('yourHand', p.hand));
    });

    // Play Card Handler
    socket.on('playCard', ({ code, cardIndex }) => {
        const lobby = lobbies[code];
        if (!lobby) return;

        const currentTurnIdx = lobby.currentTurn;
        const currentPlayer = lobby.players[currentTurnIdx];
        if (currentPlayer.id !== socket.id) return socket.emit('errorMsg', "It's not your turn!");

        const cardPlayed = currentPlayer.hand[cardIndex];
        const topCard = lobby.discardPile[lobby.discardPile.length - 1];

        // Uno Matching Rule Validation (Color or Type must match)
        if (cardPlayed.color !== topCard.color && cardPlayed.type !== topCard.type) {
            return socket.emit('errorMsg', 'Invalid move! Card must match color or type.');
        }

        // Move card from player hand to discard pile
        currentPlayer.hand.splice(cardIndex, 1);
        lobby.discardPile.push(cardPlayed);

        // Check for Game Over / Win Condition
        if (currentPlayer.hand.length === 0) {
            io.to(code).emit('gameOver', { winner: currentPlayer.name });
            delete lobbies[code];
            return;
        }

        // Process Action Cards (Skip, Reverse, +2)
        let skipCount = 1;

        if (cardPlayed.type === 'Skip') {
            skipCount = 2; // Jump over the next person
        } else if (cardPlayed.type === 'Reverse') {
            if (lobby.players.length === 2) {
                skipCount = 2; // In 2-player games, reverse acts like a skip
            } else {
                lobby.direction *= -1; // Toggle direction between 1 and -1
            }
        } else if (cardPlayed.type === '+2') {
            // Find who is next to give them the penalty
            const nextPlayerIndex = (lobby.currentTurn + lobby.direction + lobby.players.length) % lobby.players.length;
            const targetPlayer = lobby.players[nextPlayerIndex];
            
            // Draw 2 cards for them
            for (let i = 0; i < 2; i++) {
                if (lobby.deck.length > 0) targetPlayer.hand.push(lobby.deck.pop());
            }
            skipCount = 2; // Skip their turn because they drew cards
        }

        advanceTurn(lobby, skipCount);

        // Broadcast modern state updates to everyone
        io.to(code).emit('gameUpdated', {
            players: lobby.players.map(p => ({ id: p.id, name: p.name, cardCount: p.hand.length })),
            topCard: cardPlayed,
            currentTurn: lobby.currentTurn
        });

        // Update hands privately
        lobby.players.forEach(p => io.to(p.id).emit('yourHand', p.hand));
    });

    // Disconnect Handler
    socket.on('disconnect', () => {
        console.log(`User disconnected: ${socket.id}`);
        // Clean up empty lobbies if players leave
        for (const code in lobbies) {
            lobbies[code].players = lobbies[code].players.filter(p => p.id !== socket.id);
            if (lobbies[code].players.length === 0) {
                delete lobbies[code];
            } else if (lobbies[code].gameStarted) {
                io.to(code).emit('errorMsg', 'A player disconnected. Game ended.');
                delete lobbies[code];
            } else {
                io.to(code).emit('roomUpdated', { players: lobbies[code].players });
            }
        }
    });
});

server.listen(PORT, () => {
    console.log(`Uno game server running on http://localhost:${PORT}`);
});
