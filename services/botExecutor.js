import { findById } from '../models/Bot';
import { create, findOne, countDocuments } from '../models/Trade';
import { findById as _findById, findByIdAndUpdate } from '../models/User';
import { info, error as _error, warn } from '../utils/logger';

class BotExecutor {
    constructor() {
        this.activeBots = new Map(); // botId -> execution data
        this.tickData = new Map(); // symbol -> tick history
        this.setupEventListeners();
    }

    // Setup WebSocket event listeners
    setupEventListeners() {
        const wsManager = global.derivWSManager;

        // Listen for tick updates
        wsManager.on('tick', ({ userId, tick }) => {
            this.handleTickUpdate(userId, tick);
        });

        // Listen for contract updates
        wsManager.on('contract_update', ({ userId, contract }) => {
            this.handleContractUpdate(userId, contract);
        });

        // Listen for buy confirmations
        wsManager.on('buy', ({ userId, buy }) => {
            this.handleBuyConfirmation(userId, buy);
        });

        // Listen for balance updates
        wsManager.on('balance', ({ userId, balance }) => {
            this.updateUserBalance(userId, balance);
        });
    }

    // Start bot execution
    async startBot(botId, userId) {
        try {
            const bot = await findById(botId);
            if (!bot) throw new Error('Bot not found');

            info(`Starting bot ${botId} for user ${userId}`);

            // Subscribe to tick data for bot's symbol
            global.derivWSManager.subscribeTicks(userId, bot.configuration.symbol);

            // Initialize bot execution data
            this.activeBots.set(botId, {
                botId,
                userId,
                bot,
                isRunning: true,
                currentTrade: null,
                dailyLoss: 0,
                consecutiveLosses: 0,
                lastTradeTime: null,
                tickBuffer: []
            });

            // Initialize tick data storage
            if (!this.tickData.has(bot.configuration.symbol)) {
                this.tickData.set(bot.configuration.symbol, []);
            }

            info(`Bot ${botId} started successfully`);
        } catch (error) {
            _error(`Error starting bot ${botId}:`, error);
            throw error;
        }
    }

    // Stop bot execution
    async stopBot(botId) {
        try {
            const botData = this.activeBots.get(botId);
            if (!botData) return;

            info(`Stopping bot ${botId}`);

            // Unsubscribe from tick data
            global.derivWSManager.unsubscribeTicks(botData.userId, botData.bot.configuration.symbol);

            // Remove from active bots
            this.activeBots.delete(botId);

            info(`Bot ${botId} stopped successfully`);
        } catch (error) {
            _error(`Error stopping bot ${botId}:`, error);
            throw error;
        }
    }

    // Pause bot execution
    async pauseBot(botId) {
        const botData = this.activeBots.get(botId);
        if (botData) {
            botData.isRunning = false;
            info(`Bot ${botId} paused`);
        }
    }

    // Resume bot execution
    async resumeBot(botId) {
        const botData = this.activeBots.get(botId);
        if (botData) {
            botData.isRunning = true;
            info(`Bot ${botId} resumed`);
        }
    }

    // Handle tick updates
    async handleTickUpdate(userId, tick) {
        try {
            // Store tick data
            const symbol = tick.symbol;
            if (!this.tickData.has(symbol)) {
                this.tickData.set(symbol, []);
            }

            const tickHistory = this.tickData.get(symbol);
            tickHistory.push({
                time: tick.epoch,
                price: tick.quote,
                symbol: tick.symbol
            });

            // Keep only last 1000 ticks
            if (tickHistory.length > 1000) {
                tickHistory.shift();
            }

            // Process all active bots for this user and symbol
            for (const [botId, botData] of this.activeBots) {
                if (botData.userId === userId &&
                    botData.bot.configuration.symbol === symbol &&
                    botData.isRunning) {

                    // Add tick to bot's buffer
                    botData.tickBuffer.push(tick);
                    if (botData.tickBuffer.length > 100) {
                        botData.tickBuffer.shift();
                    }

                    // Check if bot should place a trade
                    await this.evaluateTradeSignal(botId, botData, tick);
                }
            }
        } catch (error) {
            _error('Error handling tick update:', error);
        }
    }

    // Evaluate if bot should place a trade
    async evaluateTradeSignal(botId, botData, currentTick) {
        try {
            // Don't trade if already in a trade
            if (botData.currentTrade) return;

            const bot = botData.bot;
            const config = bot.configuration;

            // Check risk management rules
            if (!this.checkRiskManagement(botData, bot)) {
                return;
            }

            // Check trading hours
            if (config.tradingHours?.enabled) {
                if (!this.isWithinTradingHours(config.tradingHours)) {
                    return;
                }
            }

            // Calculate indicators
            const indicators = this.calculateIndicators(botData.tickBuffer);

            // Evaluate strategy conditions
            const signal = this.evaluateStrategy(bot, indicators, currentTick);

            if (signal && signal.action !== 'HOLD') {
                await this.placeTrade(botId, botData, signal, currentTick, indicators);
            }

        } catch (error) {
            _error(`Error evaluating trade signal for bot ${botId}:`, error);

            // Log error to bot
            bot.errorLog.push({
                timestamp: new Date(),
                error: error.message,
                details: { currentTick }
            });
            await bot.save();
        }
    }

    // Check risk management rules
    checkRiskManagement(botData, bot) {
        const riskMgmt = bot.configuration.riskManagement;

        // Check max daily loss
        if (riskMgmt?.maxDailyLoss && botData.dailyLoss >= riskMgmt.maxDailyLoss) {
            warn(`Bot ${bot._id} reached max daily loss limit`);
            return false;
        }

        // Check consecutive losses
        if (riskMgmt?.maxConsecutiveLosses &&
            botData.consecutiveLosses >= riskMgmt.maxConsecutiveLosses) {
            warn(`Bot ${bot._id} reached max consecutive losses`);
            return false;
        }

        return true;
    }

    // Check if within trading hours
    isWithinTradingHours(tradingHours) {
        const now = new Date();
        const currentTime = now.getHours() * 60 + now.getMinutes();

        const [startHour, startMin] = tradingHours.start.split(':').map(Number);
        const [endHour, endMin] = tradingHours.end.split(':').map(Number);

        const startTime = startHour * 60 + startMin;
        const endTime = endHour * 60 + endMin;

        return currentTime >= startTime && currentTime <= endTime;
    }

    // Calculate technical indicators
    calculateIndicators(tickBuffer) {
        if (tickBuffer.length < 20) return null;

        const prices = tickBuffer.map(t => t.quote);
        const closePrices = prices.slice(-50);

        return {
            currentPrice: prices[prices.length - 1],
            sma20: this.calculateSMA(closePrices, 20),
            ema12: this.calculateEMA(closePrices, 12),
            ema26: this.calculateEMA(closePrices, 26),
            rsi: this.calculateRSI(closePrices, 14),
            macd: this.calculateMACD(closePrices),
            bollinger: this.calculateBollingerBands(closePrices, 20, 2)
        };
    }

    // Simple Moving Average
    calculateSMA(prices, period) {
        if (prices.length < period) return null;
        const slice = prices.slice(-period);
        return slice.reduce((sum, price) => sum + price, 0) / period;
    }

    // Exponential Moving Average
    calculateEMA(prices, period) {
        if (prices.length < period) return null;

        const multiplier = 2 / (period + 1);
        let ema = prices[0];

        for (let i = 1; i < prices.length; i++) {
            ema = (prices[i] - ema) * multiplier + ema;
        }

        return ema;
    }

    // Relative Strength Index
    calculateRSI(prices, period = 14) {
        if (prices.length < period + 1) return null;

        let gains = 0;
        let losses = 0;

        for (let i = prices.length - period; i < prices.length; i++) {
            const change = prices[i] - prices[i - 1];
            if (change > 0) gains += change;
            else losses -= change;
        }

        const avgGain = gains / period;
        const avgLoss = losses / period;

        if (avgLoss === 0) return 100;
        const rs = avgGain / avgLoss;
        return 100 - (100 / (1 + rs));
    }

    // MACD
    calculateMACD(prices) {
        const ema12 = this.calculateEMA(prices, 12);
        const ema26 = this.calculateEMA(prices, 26);

        if (!ema12 || !ema26) return null;

        const macdLine = ema12 - ema26;

        return {
            macd: macdLine,
            signal: macdLine, // Simplified, should calculate EMA of MACD
            histogram: 0
        };
    }

    // Bollinger Bands
    calculateBollingerBands(prices, period, stdDev) {
        const sma = this.calculateSMA(prices, period);
        if (!sma) return null;

        const slice = prices.slice(-period);
        const variance = slice.reduce((sum, price) => sum + Math.pow(price - sma, 2), 0) / period;
        const standardDeviation = Math.sqrt(variance);

        return {
            upper: sma + (standardDeviation * stdDev),
            middle: sma,
            lower: sma - (standardDeviation * stdDev)
        };
    }

    // Evaluate trading strategy
    evaluateStrategy(bot, indicators, currentTick) {
        if (!indicators) return { action: 'HOLD' };

        const strategy = bot.configuration.strategy;
        const type = bot.type;

        // Simple strategy based on bot type
        if (type === 'scalper' || type === 'elite_speedbot') {
            return this.scalperStrategy(indicators);
        } else if (type === 'trend_follower') {
            return this.trendFollowerStrategy(indicators);
        } else if (type === 'swing') {
            return this.swingStrategy(indicators);
        }

        // Custom strategy
        if (strategy?.entryConditions) {
            return this.evaluateCustomStrategy(strategy, indicators);
        }

        return { action: 'HOLD' };
    }

    // Scalper strategy (quick trades)
    scalperStrategy(indicators) {
        const { rsi, currentPrice, sma20, bollinger } = indicators;

        if (!rsi || !bollinger) return { action: 'HOLD' };

        // Oversold + below lower band = CALL
        if (rsi < 30 && currentPrice < bollinger.lower) {
            return { action: 'CALL', confidence: 0.8 };
        }

        // Overbought + above upper band = PUT
        if (rsi > 70 && currentPrice > bollinger.upper) {
            return { action: 'PUT', confidence: 0.8 };
        }

        return { action: 'HOLD' };
    }

    // Trend follower strategy
    trendFollowerStrategy(indicators) {
        const { ema12, ema26, macd, currentPrice } = indicators;

        if (!ema12 || !ema26 || !macd) return { action: 'HOLD' };

        // Bullish trend
        if (ema12 > ema26 && macd.macd > 0) {
            return { action: 'CALL', confidence: 0.7 };
        }

        // Bearish trend
        if (ema12 < ema26 && macd.macd < 0) {
            return { action: 'PUT', confidence: 0.7 };
        }

        return { action: 'HOLD' };
    }

    // Swing strategy
    swingStrategy(indicators) {
        const { rsi, sma20, currentPrice } = indicators;

        if (!rsi || !sma20) return { action: 'HOLD' };

        // Price above SMA and RSI neutral/bullish
        if (currentPrice > sma20 && rsi > 45 && rsi < 65) {
            return { action: 'CALL', confidence: 0.6 };
        }

        // Price below SMA and RSI neutral/bearish
        if (currentPrice < sma20 && rsi > 35 && rsi < 55) {
            return { action: 'PUT', confidence: 0.6 };
        }

        return { action: 'HOLD' };
    }

    // Evaluate custom strategy
    evaluateCustomStrategy(strategy, indicators) {
        // This would be more complex in production
        // For now, return HOLD
        return { action: 'HOLD' };
    }

    // Place a trade
    async placeTrade(botId, botData, signal, currentTick, indicators) {
        try {
            const bot = botData.bot;
            const config = bot.configuration;

            info(`Bot ${botId} placing ${signal.action} trade on ${config.symbol}`);

            // Create trade record
            const trade = await create({
                userId: botData.userId,
                botId: bot._id,
                symbol: config.symbol,
                contractType: signal.action,
                entryPrice: currentTick.quote,
                stake: config.stake,
                duration: config.duration,
                durationType: config.durationType,
                status: 'pending',
                entryTime: new Date(),
                indicators: {
                    rsi: indicators?.rsi,
                    macd: indicators?.macd,
                    ema: indicators?.ema12,
                    sma: indicators?.sma20,
                    bollinger: indicators?.bollinger
                },
                metadata: {
                    strategy: bot.type
                }
            });

            // Get proposal from Deriv
            global.derivWSManager.getProposal(botData.userId, {
                contractType: signal.action,
                symbol: config.symbol,
                stake: config.stake,
                duration: config.duration,
                durationType: config.durationType,
                currency: 'USD'
            });

            // Store current trade
            botData.currentTrade = trade;

            // Update bot
            bot.lastExecution = new Date();
            await bot.save();

        } catch (error) {
            _error(`Error placing trade for bot ${botId}:`, error);
            throw error;
        }
    }

    // Handle buy confirmation
    async handleBuyConfirmation(userId, buy) {
        try {
            // Find which bot made this trade
            for (const [botId, botData] of this.activeBots) {
                if (botData.userId === userId && botData.currentTrade) {
                    const trade = botData.currentTrade;

                    // Update trade with contract details
                    trade.contractId = buy.contract_id;
                    trade.payout = buy.payout;
                    trade.status = 'open';
                    await trade.save();

                    // Subscribe to contract updates
                    global.derivWSManager.subscribeToContract(userId, buy.contract_id);

                    info(`Trade ${trade._id} opened for bot ${botId}`);
                    break;
                }
            }
        } catch (error) {
            _error('Error handling buy confirmation:', error);
        }
    }

    // Handle contract updates
    async handleContractUpdate(userId, contract) {
        try {
            // Find the trade
            const trade = await findOne({ contractId: contract.contract_id });
            if (!trade) return;

            // Check if contract is finished
            if (contract.is_sold || contract.status === 'won' || contract.status === 'lost') {
                trade.exitPrice = contract.exit_tick || contract.current_spot;
                trade.exitTime = new Date();
                trade.status = contract.status;
                trade.profitLoss = contract.profit;
                await trade.save();

                // Update bot performance
                await this.updateBotPerformance(trade.botId, trade);

                // Clear current trade
                for (const [botId, botData] of this.activeBots) {
                    if (botData.currentTrade && botData.currentTrade._id.equals(trade._id)) {
                        botData.currentTrade = null;

                        // Update risk management data
                        if (trade.status === 'lost') {
                            botData.dailyLoss += Math.abs(trade.profitLoss);
                            botData.consecutiveLosses++;
                        } else {
                            botData.consecutiveLosses = 0;
                        }
                        break;
                    }
                }

                info(`Trade ${trade._id} closed: ${trade.status}, P/L: ${trade.profitLoss}`);
            }
        } catch (error) {
            _error('Error handling contract update:', error);
        }
    }

    // Update bot performance metrics
    async updateBotPerformance(botId, trade) {
        try {
            const bot = await findById(botId);
            if (!bot) return;

            const perf = bot.performance;

            perf.totalTrades++;

            if (trade.status === 'won') {
                perf.winningTrades++;
                perf.totalProfit += trade.profitLoss;
                perf.currentStreak = perf.currentStreak > 0 ? perf.currentStreak + 1 : 1;
                if (perf.currentStreak > perf.longestWinStreak) {
                    perf.longestWinStreak = perf.currentStreak;
                }
                if (trade.profitLoss > perf.bestTrade) {
                    perf.bestTrade = trade.profitLoss;
                }
            } else if (trade.status === 'lost') {
                perf.losingTrades++;
                perf.totalLoss += Math.abs(trade.profitLoss);
                perf.currentStreak = perf.currentStreak < 0 ? perf.currentStreak - 1 : -1;
                if (Math.abs(perf.currentStreak) > perf.longestLoseStreak) {
                    perf.longestLoseStreak = Math.abs(perf.currentStreak);
                }
                if (trade.profitLoss < perf.worstTrade) {
                    perf.worstTrade = trade.profitLoss;
                }
            }

            perf.netProfitLoss = perf.totalProfit - perf.totalLoss;

            // Update win rate
            bot.updateWinRate();

            // Update profit factor
            bot.updateProfitFactor();

            // Calculate average win/loss
            if (perf.winningTrades > 0) {
                perf.averageWin = perf.totalProfit / perf.winningTrades;
            }
            if (perf.losingTrades > 0) {
                perf.averageLoss = perf.totalLoss / perf.losingTrades;
            }

            await bot.save();

            // Also update user statistics
            await this.updateUserStatistics(trade.userId, trade);

        } catch (error) {
            _error('Error updating bot performance:', error);
        }
    }

    // Update user statistics
    async updateUserStatistics(userId, trade) {
        try {
            const user = await _findById(userId);
            if (!user) return;

            const stats = user.statistics;

            stats.totalTrades++;
            stats.profitLoss += trade.profitLoss;

            if (trade.profitLoss > stats.bestTrade) {
                stats.bestTrade = trade.profitLoss;
            }
            if (trade.profitLoss < stats.worstTrade) {
                stats.worstTrade = trade.profitLoss;
            }

            // Recalculate win rate
            const totalWins = await countDocuments({ userId, status: 'won' });
            stats.winRate = stats.totalTrades > 0 ? (totalWins / stats.totalTrades) * 100 : 0;

            await user.save();
        } catch (error) {
            _error('Error updating user statistics:', error);
        }
    }

    // Update user balance
    async updateUserBalance(userId, balance) {
        try {
            await findByIdAndUpdate(userId, {
                balance: balance.balance,
                currency: balance.currency
            });
        } catch (error) {
            _error('Error updating user balance:', error);
        }
    }
}

export default BotExecutor;