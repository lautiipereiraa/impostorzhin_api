const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());

const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

const rooms = {};

const wordsPath = path.join(__dirname, 'words.json');
let CATEGORIES = {};

try {
    const data = fs.readFileSync(wordsPath, 'utf8');
    CATEGORIES = JSON.parse(data);
    console.log('Palabras cargadas:', Object.keys(CATEGORIES).length, 'categorías');
} catch (err) {
    console.error('Error cargando words.json', err);
    CATEGORIES = { 'error': ['Error cargando palabras'] };
}

function generateRoomCode() {
    return Math.random().toString(36).substring(2, 6).toUpperCase();
}

function getRandomElement(arr) {
    return arr[Math.floor(Math.random() * arr.length)];
}

function getSafePlayers(players) {
    return players.map(p => ({
        id: p.id,
        username: p.username,
        isHost: p.isHost,
        connected: p.connected,
        isAlive: p.isAlive,
    }));
}

io.on('connection', (socket) => {
    console.log(`User Connected: ${socket.id}`);

    socket.on('create_room', ({ username, gameMode, initialPlayers }) => {
        const roomCode = generateRoomCode();
        rooms[roomCode] = {
            players: [],
            state: 'lobby',
            gameMode: gameMode || 'online',
            word: null,
            category: null,
            impostorUsername: null,
            startingPlayerUsername: null,
            lastResult: null
        };

        if (gameMode === 'local' && Array.isArray(initialPlayers)) {
            initialPlayers.forEach((name, index) => {
                rooms[roomCode].players.push({
                    id: `${socket.id}-${index}`,
                    socketId: socket.id,
                    username: name,
                    isHost: index === 0,
                    connected: true
                });
            });
        } else {
            const player = { id: socket.id, username, isHost: true, connected: true };
            rooms[roomCode].players.push(player);
        }

        socket.join(roomCode);

        socket.emit('room_joined', {
            roomCode,
            players: getSafePlayers(rooms[roomCode].players),
            gameMode: rooms[roomCode].gameMode,
            isHost: true
        });
        console.log(`Sala creada ${roomCode} (Modo: ${rooms[roomCode].gameMode})`);
    });

    socket.on('join_room', ({ username, roomCode }) => {
        const code = roomCode.toUpperCase();

        if (rooms[code]) {
            const room = rooms[code];
            const existingPlayerIndex = room.players.findIndex(p => p.username === username);

            if (existingPlayerIndex !== -1) {
                const player = room.players[existingPlayerIndex];
                const oldId = player.id;

                if (player.deletionTimeout) {
                    clearTimeout(player.deletionTimeout);
                    player.deletionTimeout = null;
                }

                console.log(`Jugador reconectado: ${username} en sala ${code}`);

                player.id = socket.id;
                player.socketId = socket.id;
                player.connected = true;

                if (room.gameMode === 'local') {
                    room.players.forEach((p, idx) => {
                        p.id = `${socket.id}-${idx}`;
                        p.socketId = socket.id;
                    });
                }

                socket.join(code);

                let playerHasVoted = false;
                if (room.state === 'voting' && room.voters) {
                    if (room.voters.has(oldId)) {
                        room.voters.delete(oldId);
                        room.voters.add(socket.id);
                        playerHasVoted = true;
                    }
                }

                socket.emit('room_joined', {
                    roomCode: code,
                    players: getSafePlayers(room.players),
                    gameMode: room.gameMode,
                    isHost: player.isHost
                });

                if (room.state === 'assigned_roles' || room.state === 'game' || room.state === 'voting') {

                    if (room.gameMode === 'local') {
                        console.log(`Reconexión LOCAL en sala ${code}`);

                        const playersPayload = room.players.map((p) => {
                            const isImp = p.username === room.impostorUsername;
                            return {
                                ...getSafePlayers([p])[0],
                                role: isImp ? 'impostor' : 'crewmate',
                                word: isImp ? null : room.word
                            };
                        });

                        socket.emit('local_game_data', {
                            playersData: playersPayload,
                            startingPlayer: room.startingPlayerUsername,
                            category: room.category
                        });

                    } else {
                        socket.emit('game_started', {
                            category: room.category,
                            startingPlayer: room.startingPlayerUsername
                        });

                        const isImpostor = player.username === room.impostorUsername;
                        socket.emit('your_role', {
                            role: isImpostor ? 'impostor' : 'crewmate',
                            word: isImpostor ? null : room.word,
                            startingPlayer: room.startingPlayerUsername
                        });
                    }

                    if (room.state === 'voting') {
                        socket.emit('voting_started', { hasVoted: playerHasVoted });
                    }

                } else if (room.state === 'results' && room.lastResult) {
                    socket.emit('game_results', room.lastResult);
                }

            } else {
                const player = { id: socket.id, username, isHost: room.players.length === 0, connected: true };
                room.players.push(player);
                socket.join(code);

                socket.emit('room_joined', {
                    roomCode: code,
                    players: getSafePlayers(room.players),
                    gameMode: room.gameMode,
                    isHost: player.isHost
                });
            }

            io.to(code).emit('player_update', getSafePlayers(room.players));
            console.log(`${username} se unió/actualizó en ${code}`);

        } else {
            socket.emit('error', 'Sala no encontrada');
        }
    });

    socket.on('start_game', ({ roomCode, category }) => {
        const room = rooms[roomCode];
        if (!room) return;

        const selectedCategory = category || getRandomElement(Object.keys(CATEGORIES));
        const secretWord = getRandomElement(CATEGORIES[selectedCategory]);

        room.category = selectedCategory;
        room.word = secretWord;
        room.lastResult = null;

        const impostorIndex = Math.floor(Math.random() * room.players.length);
        const impostorPlayer = room.players[impostorIndex];
        room.impostorUsername = impostorPlayer.username;

        room.state = 'game';

        const crewmates = room.players.filter(p => p.username !== room.impostorUsername);
        const startingPlayer = getRandomElement(crewmates);
        room.startingPlayerUsername = startingPlayer.username;

        room.players.forEach(p => p.isAlive = true);

        const gamePayload = {
            category: selectedCategory,
            startingPlayer: startingPlayer.username
        };

        if (room.gameMode === 'online') {
            io.to(roomCode).emit('game_started', gamePayload);

            room.players.forEach(player => {
                const isImpostor = player.username === room.impostorUsername;
                io.to(player.id).emit('your_role', {
                    role: isImpostor ? 'impostor' : 'crewmate',
                    word: isImpostor ? null : secretWord,
                    startingPlayer: startingPlayer.username
                });
            });
        } else {
            const playersPayload = room.players.map((p, index) => ({
                ...getSafePlayers([p])[0],
                role: index === impostorIndex ? 'impostor' : 'crewmate',
                word: index === impostorIndex ? null : secretWord
            }));

            io.to(roomCode).emit('local_game_data', {
                playersData: playersPayload,
                startingPlayer: startingPlayer.username,
                category: selectedCategory
            });
        }

        console.log(`Juego iniciado. Sala: ${roomCode}`);
    });

    socket.on('start_voting', ({ roomCode }) => {
        const room = rooms[roomCode];
        if (!room) return;

        room.state = 'voting';
        room.votes = {};
        io.to(roomCode).emit('voting_started', { hasVoted: false });
    });

    socket.on('cast_vote', ({ roomCode, votedPlayerId }) => {
        const room = rooms[roomCode];
        if (!room || room.state !== 'voting') return;

        const voter = room.players.find(p => p.id === socket.id);
        if (!voter || !voter.isAlive) return;

        if (!room.voters) room.voters = new Set();
        if (room.voters.has(socket.id)) return;

        room.voters.add(socket.id);

        if (!room.votes) room.votes = {};
        room.votes[votedPlayerId] = (room.votes[votedPlayerId] || 0) + 1;

        const aliveCount = room.players.filter(p => p.isAlive).length;

        if (room.voters.size >= aliveCount) {
            finishVoting(roomCode);
        }
    });

    socket.on('local_elimination', ({ roomCode, eliminatedPlayerId }) => {
        const room = rooms[roomCode];
        if (!room) return;

        const eliminatedPlayer = room.players.find(p => p.id === eliminatedPlayerId);
        if (!eliminatedPlayer) return;

        let gameEnds = false;
        let winner = null;

        eliminatedPlayer.isAlive = false;

        if (eliminatedPlayer.username === room.impostorUsername) {
            gameEnds = true;
            winner = 'crewmates';
        } else {
            const alivePlayers = room.players.filter(p => p.isAlive).length;
            if (alivePlayers <= 2) {
                gameEnds = true;
                winner = 'impostor';
            } else {
                gameEnds = false;
            }
        }

        const impostorPlayer = room.players.find(p => p.username === room.impostorUsername);

        if (gameEnds) {
            room.state = 'results';
            room.lastResult = {
                winner,
                eliminated: eliminatedPlayer.username,
                impostorName: impostorPlayer ? impostorPlayer.username : '?',
                word: room.word
            };
            io.to(roomCode).emit('game_results', room.lastResult);
        } else {
            room.state = 'game';
            io.to(roomCode).emit('round_continued', {
                eliminated: eliminatedPlayer.username,
                isTie: false,
                players: getSafePlayers(room.players)
            });
        }
    });

    function finishVoting(roomCode) {
        const room = rooms[roomCode];

        let maxVotes = -1;
        let eliminatedId = null;
        let isTie = false;

        for (const [playerId, count] of Object.entries(room.votes)) {
            if (count > maxVotes) {
                maxVotes = count;
                eliminatedId = playerId;
                isTie = false;
            } else if (count === maxVotes) {
                isTie = true;
            }
        }

        let eliminatedName = 'Nadie (Empate)';
        let gameEnds = false;
        let winner = null;

        if (!isTie && eliminatedId) {
            const eliminatedPlayer = room.players.find(p => p.id === eliminatedId);
            if (eliminatedPlayer) {
                eliminatedName = eliminatedPlayer.username;
                eliminatedPlayer.isAlive = false;

                if (eliminatedPlayer.username === room.impostorUsername) {
                    gameEnds = true;
                    winner = 'crewmates';
                } else {
                    const alivePlayers = room.players.filter(p => p.isAlive).length;
                    if (alivePlayers <= 2) {
                        gameEnds = true;
                        winner = 'impostor';
                    } else {
                        gameEnds = false;
                    }
                }
            }
        }

        const impostorPlayer = room.players.find(p => p.username === room.impostorUsername);

        if (gameEnds) {
            room.state = 'results';
            room.lastResult = {
                winner,
                eliminated: eliminatedName,
                impostorName: impostorPlayer ? impostorPlayer.username : '?',
                word: room.word
            };
            io.to(roomCode).emit('game_results', room.lastResult);
        } else {
            room.state = 'game';
            room.votes = {};
            room.voters = new Set();

            io.to(roomCode).emit('round_continued', {
                eliminated: eliminatedName,
                isTie: isTie || !eliminatedId,
                players: getSafePlayers(room.players)
            });
        }
    }

    socket.on('play_again', ({ roomCode }) => {
        const room = rooms[roomCode];
        if (!room) return;

        room.state = 'lobby';
        room.word = null;
        room.category = null;
        room.impostorUsername = null;
        room.startingPlayerUsername = null;
        room.votes = {};
        room.voters = new Set();
        room.lastResult = null;

        room.players.forEach(p => p.isAlive = true);

        io.to(roomCode).emit('back_to_lobby', {
            players: getSafePlayers(room.players)
        });
    });

    socket.on('kick_player', ({ roomCode, playerId }) => {
        const room = rooms[roomCode];
        if (!room) return;

        const requester = room.players.find(p => p.id === socket.id);
        if (!requester || !requester.isHost) return;

        if (socket.id === playerId) return;

        room.players = room.players.filter(p => p.id !== playerId);
        io.to(roomCode).emit('player_update', getSafePlayers(room.players));

        const kickedSocket = io.sockets.sockets.get(playerId);
        if (kickedSocket) {
            kickedSocket.leave(roomCode);
            kickedSocket.emit('error', 'Has sido expulsado de la nave por el Capitán.');
            kickedSocket.emit('room_joined', { roomCode: null, players: [] });
        }
    });

    socket.on('leave_room', ({ roomCode }) => {
        const room = rooms[roomCode];
        if (!room) return;

        const playerIndex = room.players.findIndex(p => p.id === socket.id);
        if (playerIndex !== -1) {
            const player = room.players[playerIndex];
            const wasHost = player.isHost;

            room.players.splice(playerIndex, 1);
            socket.leave(roomCode);

            if (room.players.length === 0) {
                delete rooms[roomCode];
            } else {
                if (wasHost && room.players.length > 0) {
                    room.players[0].isHost = true;
                }

                if (room.state !== 'lobby') {
                    room.state = 'lobby';
                    room.word = null;
                    room.category = null;
                    room.impostorUsername = null;
                    room.startingPlayerUsername = null;
                    room.votes = {};
                    room.voters = new Set();
                    room.lastResult = null;

                    io.to(roomCode).emit('game_terminated', {
                        message: `¡ALERTA! La misión ha sido abortada. ${player.username} abandonó la nave.`,
                        players: getSafePlayers(room.players)
                    });
                } else {
                    io.to(roomCode).emit('player_update', getSafePlayers(room.players));
                }
            }
        }
    });

    socket.on('disconnect', () => {
        for (const roomCode in rooms) {
            const room = rooms[roomCode];
            const playerIndex = room.players.findIndex(p => p.id === socket.id);

            if (playerIndex !== -1) {
                const player = room.players[playerIndex];

                if (room.gameMode === 'local') {
                    room.players.splice(playerIndex, 1);
                    if (room.players.length === 0) delete rooms[roomCode];
                    return;
                }

                player.connected = false;
                io.to(roomCode).emit('player_update', getSafePlayers(room.players));

                player.deletionTimeout = setTimeout(() => {
                    if (rooms[roomCode]) {
                        const currentRoom = rooms[roomCode];
                        const idx = currentRoom.players.findIndex(p => p.username === player.username);

                        if (idx !== -1 && currentRoom.players[idx].deletionTimeout) {
                            const wasHost = currentRoom.players[idx].isHost;
                            currentRoom.players.splice(idx, 1);

                            if (currentRoom.players.length === 0) {
                                delete rooms[roomCode];
                            } else {
                                if (wasHost && currentRoom.players.length > 0) {
                                    currentRoom.players[0].isHost = true;
                                }

                                if (currentRoom.state !== 'lobby') {
                                    currentRoom.state = 'lobby';
                                    currentRoom.word = null;
                                    currentRoom.category = null;
                                    currentRoom.impostorUsername = null;
                                    currentRoom.startingPlayerUsername = null;
                                    currentRoom.votes = {};
                                    currentRoom.voters = new Set();
                                    currentRoom.lastResult = null;

                                    io.to(roomCode).emit('game_terminated', {
                                        message: `CONEXIÓN PERDIDA. La misíón se canceló porque ${player.username} se perdió en el espacio exterior.`,
                                        players: getSafePlayers(currentRoom.players)
                                    });
                                } else {
                                    io.to(roomCode).emit('player_update', getSafePlayers(currentRoom.players));
                                }
                            }
                        }
                    }
                }, 60000);

                break;
            }
        }
    });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
    console.log(`backend corriendo en el puerto ${PORT}`);
});
