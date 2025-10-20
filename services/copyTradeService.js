import { findOne, create, findById, aggregate } from '../models/Trade';
import { findById as _findById } from '../models/User';
import { info, warn, error as _error } from '../utils/logger';

class CopyTradeService {
    constructor() {
        this.followers = new Map(); // leaderId -> Set of followerIds
        this.dailyLoss = new Map(); // followerId -> daily loss amount
        this.setupEventListeners();
    }

    // Setup event listeners for leader trades
    setupEventListeners() {
        const wsManager = global.derivWSManager;

        // Listen for buy confirmations to replicate trades
        wsManager.on('buy', async ({ userId, buy }) => {
            await this.replicateTrade(userId, buy);
        });
    }

    // Register a follower
    async registerFollower(followerId, leaderId) {
        if (!this.followers.has(leaderId)) {
            this.followers.set(leaderId, new Set());
        }
        this.followers.get(leaderId).add(followerId);
        this.dailyLoss.set(followerId, 0);

        info(`Follower ${followerId} registered for leader ${leaderId}`);
    }

    // Unregister a follower
    async unregisterFollower(followerId, leaderId) {
        if (this.followers.has(leaderId)) {
            this.followers.get(leaderId).delete(followerId);
        }

        info(`Follower ${followerId} unregistered from leader ${leaderId}`);
    }

    // Replicate a leader's trade to followers
    async replicateTrade(leaderId, buyDetails) {
        try {
            // Check if this user is a leader with followers
            const leaderFollowers = this.followers.get(leaderId);
            if (!leaderFollowers || leaderFollowers.size === 0) {
                return;
            }

            // Get the original trade
            const originalTrade = await findOne({
                userId: leaderId,
                contractId: buyDetails.contract_id
            });

            if (!originalTrade) {
                warn(`Original trade not found for contract ${buyDetails.contract_id}`);
                return;
            }

            // Get leader info
            const leader = await _findById(leaderId);

            // Replicate to each follower
            for (const followerId of leaderFollowers) {
                try {
                    await this.copyTradeToFollower(followerId, leader, originalTrade, buyDetails);
                } catch (error) {
                    _error(`Error copying trade to follower ${followerId}:`, error);
                }
            }

        } catch (error) {
            _error('Error replicating trade:', error);
        }
    }

    // Copy trade to a specific follower
    async copyTradeToFollower(followerId, leader, originalTrade, buyDetails) {
        try {
            // Get follower
            const follower = await _findById(followerId);
            if (!follower || !follower.copyTradeSettings.enabled) {
                return;
            }

            // Check if follower is still following this leader
            if (!follower.following.includes(leader._id)) {
                this.unregisterFollower(followerId, leader._id.toString());
                return;
            }

            // Check risk management
            const dailyLoss = this.dailyLoss.get(followerId) || 0;
            if (dailyLoss >= follower.copyTradeSettings.maxDailyLoss) {
                warn(`Follower ${followerId} reached max daily loss`);
                return;
            }

            // Check if follower is connected to Deriv
            if (!global.derivWSManager.isConnected(followerId)) {
                warn(`Follower ${followerId} not connected to Deriv`);
                return;
            }

            // Calculate stake based on follower's settings
            const stake = this.calculateFollowerStake(follower, originalTrade.stake);

            // Check if follower has sufficient balance
            if (follower.balance < stake) {
                warn(`Follower ${followerId} has insufficient balance`);
                return;
            }

            // Create copy trade record
            const copyTrade = await create({
                userId: followerId,
                symbol: originalTrade.symbol,
                contractType: originalTrade.contractType,
                entryPrice: originalTrade.entryPrice,
                stake: stake,
                duration: originalTrade.duration,
                durationType: originalTrade.durationType,
                status: 'pending',
                entryTime: new Date(),
                metadata: {
                    isCopyTrade: true,
                    copyTradeFrom: leader._id,
                    originalTradeId: originalTrade._id
                }
            });

            // Place the trade via Deriv WebSocket
            global.derivWSManager.getProposal(followerId, {
                contractType: originalTrade.contractType,
                symbol: originalTrade.symbol,
                stake: stake,
                duration: originalTrade.duration,
                durationType: originalTrade.durationType,
                currency: follower.currency
            });

            info(`Copy trade created for follower ${followerId} from leader ${leader._id}`);

            // Setup listener for this specific copy trade
            this.setupCopyTradeListener(followerId, copyTrade._id);

        } catch (error) {
            _error(`Error copying trade to follower ${followerId}:`, error);
            throw error;
        }
    }

    // Calculate follower's stake based on their settings
    calculateFollowerStake(follower, originalStake) {
        const settings = follower.copyTradeSettings;

        // Use fixed investment per trade if set
        if (settings.investmentPerTrade) {
            return settings.investmentPerTrade;
        }

        // Or use risk percentage of balance
        if (settings.riskPercentage) {
            return (follower.balance * settings.riskPercentage) / 100;
        }

        // Default to same stake (with max limit)
        return Math.min(originalStake, follower.balance * 0.02); // Max 2% of balance
    }

    // Setup listener for copy trade completion
    setupCopyTradeListener(followerId, tradeId) {
        const wsManager = global.derivWSManager;

        const contractUpdateHandler = async ({ userId, contract }) => {
            if (userId !== followerId) return;

            try {
                const trade = await findById(tradeId);
                if (!trade || trade.contractId !== contract.contract_id) return;

                // Update daily loss tracking
                if (contract.is_sold || contract.status === 'won' || contract.status === 'lost') {
                    if (contract.status === 'lost') {
                        const currentLoss = this.dailyLoss.get(followerId) || 0;
                        this.dailyLoss.set(followerId, currentLoss + Math.abs(contract.profit));
                    }

                    // Remove listener
                    wsManager.off('contract_update', contractUpdateHandler);
                }
            } catch (error) {
                _error('Error in copy trade listener:', error);
            }
        };

        wsManager.on('contract_update', contractUpdateHandler);
    }

    // Reset daily loss tracking (should be called daily)
    resetDailyLoss() {
        this.dailyLoss.clear();
        info('Daily loss tracking reset');
    }

    // Get copy trading statistics
    async getCopyTradeStats(userId) {
        try {
            const stats = await aggregate([
                {
                    $match: {
                        userId: mongoose.Types.ObjectId(userId),
                        'metadata.isCopyTrade': true,
                        status: { $in: ['won', 'lost'] }
                    }
                },
                {
                    $group: {
                        _id: '$metadata.copyTradeFrom',
                        totalTrades: { $sum: 1 },
                        wins: { $sum: { $cond: [{ $eq: ['$status', 'won'] }, 1, 0] } },
                        totalProfit: { $sum: '$profitLoss' },
                        avgProfit: { $avg: '$profitLoss' }
                    }
                },
                {
                    $lookup: {
                        from: 'users',
                        localField: '_id',
                        foreignField: '_id',
                        as: 'leader'
                    }
                },
                {
                    $unwind: '$leader'
                },
                {
                    $project: {
                        leaderId: '$_id',
                        leaderName: '$leader.username',
                        totalTrades: 1,
                        wins: 1,
                        winRate: { $multiply: [{ $divide: ['$wins', '$totalTrades'] }, 100] },
                        totalProfit: 1,
                        avgProfit: 1
                    }
                }
            ]);

            return stats;
        } catch (error) {
            _error('Error getting copy trade stats:', error);
            throw error;
        }
    }

    // Get active copy traders for a leader
    getFollowerCount(leaderId) {
        const followers = this.followers.get(leaderId);
        return followers ? followers.size : 0;
    }
}

export default CopyTradeService;