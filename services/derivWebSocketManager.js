import WebSocket, { OPEN } from 'ws';
import { info, error as _error, warn } from '../utils/logger';
import encryption from '../utils/encryption';
import EventEmitter from 'events';

class DerivWebSocketManager extends EventEmitter {
    constructor() {
        super();
        this.connections = new Map(); // userId -> connection object
        this.reconnectAttempts = new Map();
        this.maxReconnectAttempts = 5;
        this.reconnectDelay = 3000;
    }

    // Create a new WebSocket connection for a user
    async connect(userId, derivToken) {
        try {
            // Close existing connection if any
            if (this.connections.has(userId)) {
                await this.disconnect(userId);
            }

            const wsUrl = `${process.env.DERIV_WEBSOCKET_URL}?app_id=${process.env.DERIV_APP_ID}`;
            const ws = new WebSocket(wsUrl);

            const connectionData = {
                ws,
                userId,
                token: derivToken,
                isAuthenticated: false,
                subscriptions: new Set(),
                messageQueue: [],
                lastPing: Date.now()
            };

            // Setup WebSocket event handlers
            ws.on('open', () => {
                info(`WebSocket connected for user ${userId}`);
                this.authenticate(userId, derivToken);
            });

            ws.on('message', (data) => {
                this.handleMessage(userId, data);
            });

            ws.on('error', (error) => {
                _error(`WebSocket error for user ${userId}:`, error);
                this.emit('error', { userId, error });
            });

            ws.on('close', (code, reason) => {
                warn(`WebSocket closed for user ${userId}: ${code} - ${reason}`);
                this.handleDisconnect(userId);
            });

            // Store connection
            this.connections.set(userId, connectionData);
            this.reconnectAttempts.set(userId, 0);

            return true;
        } catch (error) {
            _error(`Failed to connect WebSocket for user ${userId}:`, error);
            throw error;
        }
    }

    // Authenticate with Deriv API
    authenticate(userId, token) {
        const message = {
            authorize: token
        };
        this.send(userId, message);
    }

    // Handle incoming WebSocket messages
    handleMessage(userId, data) {
        try {
            const message = JSON.parse(data.toString());
            const connection = this.connections.get(userId);

            if (!connection) return;

            // Handle authorization response
            if (message.authorize) {
                connection.isAuthenticated = true;
                info(`User ${userId} authenticated successfully`);
                this.emit('authenticated', { userId, accountInfo: message.authorize });

                // Process queued messages
                this.processMessageQueue(userId);

                // Subscribe to initial data
                this.subscribeToInitialData(userId);
            }

            // Handle balance updates
            if (message.balance) {
                this.emit('balance', { userId, balance: message.balance });
            }

            // Handle portfolio updates
            if (message.portfolio) {
                this.emit('portfolio', { userId, portfolio: message.portfolio });
            }

            // Handle statement updates
            if (message.statement) {
                this.emit('statement', { userId, statement: message.statement });
            }

            // Handle tick updates
            if (message.tick) {
                this.emit('tick', { userId, tick: message.tick });
            }

            // Handle proposal (contract price) updates
            if (message.proposal) {
                this.emit('proposal', { userId, proposal: message.proposal });
            }

            // Handle buy response
            if (message.buy) {
                this.emit('buy', { userId, buy: message.buy });
            }

            // Handle proposal open contract updates
            if (message.proposal_open_contract) {
                this.emit('contract_update', { userId, contract: message.proposal_open_contract });
            }

            // Handle errors
            if (message.error) {
                _error(`Deriv API error for user ${userId}:`, message.error);
                this.emit('api_error', { userId, error: message.error });
            }

            // Handle ping/pong
            if (message.ping) {
                this.send(userId, { ping: 1 });
                connection.lastPing = Date.now();
            }

        } catch (error) {
            _error(`Error handling message for user ${userId}:`, error);
        }
    }

    // Subscribe to initial data streams
    subscribeToInitialData(userId) {
        // Subscribe to balance updates
        this.send(userId, { balance: 1, subscribe: 1 });

        // Subscribe to portfolio updates
        this.send(userId, { portfolio: 1, subscribe: 1 });

        // Get recent transactions
        this.send(userId, { statement: 1, limit: 50 });
    }

    // Subscribe to tick data for a symbol
    subscribeTicks(userId, symbol) {
        const connection = this.connections.get(userId);
        if (!connection) {
            warn(`Cannot subscribe to ticks: No connection for user ${userId}`);
            return;
        }

        const message = {
            ticks: symbol,
            subscribe: 1
        };

        this.send(userId, message);
        connection.subscriptions.add(`ticks_${symbol}`);
        info(`User ${userId} subscribed to ticks for ${symbol}`);
    }

    // Unsubscribe from tick data
    unsubscribeTicks(userId, symbol) {
        const connection = this.connections.get(userId);
        if (!connection) return;

        const message = {
            forget: symbol
        };

        this.send(userId, message);
        connection.subscriptions.delete(`ticks_${symbol}`);
        info(`User ${userId} unsubscribed from ticks for ${symbol}`);
    }

    // Get contract proposal (price calculation)
    getProposal(userId, params) {
        const message = {
            proposal: 1,
            amount: params.stake,
            basis: 'stake',
            contract_type: params.contractType,
            currency: params.currency || 'USD',
            duration: params.duration,
            duration_unit: params.durationType || 't',
            symbol: params.symbol,
            subscribe: 1
        };

        this.send(userId, message);
    }

    // Buy a contract
    buyContract(userId, params) {
        const message = {
            buy: params.proposalId || params.contractId,
            price: params.price
        };

        this.send(userId, message);
        info(`User ${userId} buying contract:`, params);
    }

    // Subscribe to open contract updates
    subscribeToContract(userId, contractId) {
        const message = {
            proposal_open_contract: 1,
            contract_id: contractId,
            subscribe: 1
        };

        this.send(userId, message);
    }

    // Send message to user's WebSocket
    send(userId, message) {
        const connection = this.connections.get(userId);

        if (!connection) {
            warn(`No connection found for user ${userId}`);
            return false;
        }

        if (!connection.isAuthenticated && !message.authorize) {
            // Queue messages until authenticated
            connection.messageQueue.push(message);
            return false;
        }

        if (connection.ws.readyState === OPEN) {
            try {
                connection.ws.send(JSON.stringify(message));
                return true;
            } catch (error) {
                _error(`Error sending message to user ${userId}:`, error);
                return false;
            }
        } else {
            warn(`WebSocket not open for user ${userId}, queuing message`);
            connection.messageQueue.push(message);
            return false;
        }
    }

    // Process queued messages
    processMessageQueue(userId) {
        const connection = this.connections.get(userId);
        if (!connection || !connection.isAuthenticated) return;

        while (connection.messageQueue.length > 0) {
            const message = connection.messageQueue.shift();
            this.send(userId, message);
        }
    }

    // Handle disconnection
    async handleDisconnect(userId) {
        const attempts = this.reconnectAttempts.get(userId) || 0;

        if (attempts < this.maxReconnectAttempts) {
            info(`Attempting to reconnect user ${userId} (attempt ${attempts + 1})`);
            this.reconnectAttempts.set(userId, attempts + 1);

            setTimeout(async () => {
                const connection = this.connections.get(userId);
                if (connection && connection.token) {
                    await this.connect(userId, connection.token);
                }
            }, this.reconnectDelay * (attempts + 1));
        } else {
            _error(`Max reconnection attempts reached for user ${userId}`);
            this.emit('max_reconnect_failed', { userId });
            this.connections.delete(userId);
            this.reconnectAttempts.delete(userId);
        }
    }

    // Disconnect a user
    async disconnect(userId) {
        const connection = this.connections.get(userId);

        if (connection) {
            try {
                if (connection.ws.readyState === OPEN) {
                    connection.ws.close(1000, 'User disconnected');
                }
            } catch (error) {
                _error(`Error closing WebSocket for user ${userId}:`, error);
            }

            this.connections.delete(userId);
            this.reconnectAttempts.delete(userId);
            info(`User ${userId} disconnected`);
        }
    }

    // Check if user is connected
    isConnected(userId) {
        const connection = this.connections.get(userId);
        return connection &&
            connection.ws.readyState === OPEN &&
            connection.isAuthenticated;
    }

    // Get active connection count
    getActiveConnectionCount() {
        let count = 0;
        for (const [userId, connection] of this.connections) {
            if (connection.ws.readyState === OPEN) {
                count++;
            }
        }
        return count;
    }

    // Close all connections
    closeAll() {
        info('Closing all WebSocket connections');
        for (const [userId] of this.connections) {
            this.disconnect(userId);
        }
    }

    // Health check - ping all connections
    healthCheck() {
        const now = Date.now();
        const timeout = 60000; // 60 seconds

        for (const [userId, connection] of this.connections) {
            if (now - connection.lastPing > timeout) {
                warn(`Connection timeout for user ${userId}, reconnecting`);
                this.handleDisconnect(userId);
            } else if (connection.ws.readyState === OPEN) {
                this.send(userId, { ping: 1 });
            }
        }
    }
}

export default DerivWebSocketManager;