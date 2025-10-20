import { find, findOne, findById } from '../models/User';
import { find as _find, aggregate, countDocuments } from '../models/Trade';
import { error as _error } from '../utils/logger';
import CopyTradeService from '../services/copyTradeService';

const copyTradeService = new CopyTradeService();

// @desc    Get all leaders
// @route   GET /api/copytrade/leaders
// @access  Private
export async function getLeaders(req, res) {
    try {
        const { sort = '-statistics.winRate', limit = 20 } = req.query;

        const leaders = await find({
            isLeader: true,
            isActive: true,
            'statistics.totalTrades': { $gte: 10 } // Minimum trades to be visible
        })
            .select('username statistics followers isLeader')
            .sort(sort)
            .limit(parseInt(limit));

        res.json({
            success: true,
            count: leaders.length,
            leaders
        });
    } catch (error) {
        _error('Get leaders error:', error);
        res.status(500).json({
            success: false,
            message: 'Error fetching leaders'
        });
    }
}

// @desc    Get leader details
// @route   GET /api/copytrade/leaders/:id
// @access  Private
export async function getLeader(req, res) {
    try {
        const leader = await findOne({
            _id: req.params.id,
            isLeader: true
        })
            .select('username statistics followers isLeader createdAt')
            .populate('followers', 'username');

        if (!leader) {
            return res.status(404).json({
                success: false,
                message: 'Leader not found'
            });
        }

        // Get recent trades
        const recentTrades = await _find({
            userId: leader._id,
            status: { $in: ['won', 'lost'] }
        })
            .sort({ createdAt: -1 })
            .limit(50)
            .select('symbol contractType profitLoss status createdAt');

        // Calculate performance metrics
        const performanceData = await aggregate([
            {
                $match: {
                    userId: leader._id,
                    status: { $in: ['won', 'lost'] },
                    createdAt: { $gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) }
                }
            },
            {
                $group: {
                    _id: null,
                    totalProfit: { $sum: { $cond: [{ $eq: ['$status', 'won'] }, '$profitLoss', 0] } },
                    totalLoss: { $sum: { $cond: [{ $eq: ['$status', 'lost'] }, { $abs: '$profitLoss' }, 0] } },
                    avgProfit: { $avg: '$profitLoss' },
                    totalTrades: { $sum: 1 }
                }
            }
        ]);

        res.json({
            success: true,
            leader: {
                ...leader.toObject(),
                recentTrades,
                last30Days: performanceData[0] || {}
            }
        });
    } catch (error) {
        _error('Get leader error:', error);
        res.status(500).json({
            success: false,
            message: 'Error fetching leader details'
        });
    }
}

// @desc    Follow a leader
// @route   POST /api/copytrade/follow/:leaderId
// @access  Private
export async function followLeader(req, res) {
    try {
        const { leaderId } = req.params;
        const { investmentPerTrade, riskPercentage, maxDailyLoss } = req.body;

        // Check if user has subscription for copy trading
        if (!req.user.hasActiveSubscription() || req.user.subscription.type === 'free') {
            return res.status(403).json({
                success: false,
                message: 'Elite subscription required for copy trading'
            });
        }

        // Check if trying to follow self
        if (leaderId === req.user.id) {
            return res.status(400).json({
                success: false,
                message: 'Cannot follow yourself'
            });
        }

        // Get leader
        const leader = await findOne({ _id: leaderId, isLeader: true });
        if (!leader) {
            return res.status(404).json({
                success: false,
                message: 'Leader not found'
            });
        }

        // Check if already following
        if (req.user.following.includes(leaderId)) {
            return res.status(400).json({
                success: false,
                message: 'Already following this leader'
            });
        }

        // Update user copy trade settings
        req.user.copyTradeSettings = {
            enabled: true,
            investmentPerTrade: investmentPerTrade || 10,
            riskPercentage: riskPercentage || 2,
            maxDailyLoss: maxDailyLoss || 100
        };
        req.user.following.push(leaderId);
        await req.user.save();

        // Update leader's followers
        leader.followers.push(req.user._id);
        await leader.save();

        // Register with copy trade service
        await copyTradeService.registerFollower(req.user._id.toString(), leaderId);

        res.json({
            success: true,
            message: 'Successfully following leader',
            settings: req.user.copyTradeSettings
        });
    } catch (error) {
        _error('Follow leader error:', error);
        res.status(500).json({
            success: false,
            message: 'Error following leader'
        });
    }
}

// @desc    Unfollow a leader
// @route   DELETE /api/copytrade/unfollow/:leaderId
// @access  Private
export async function unfollowLeader(req, res) {
    try {
        const { leaderId } = req.params;

        // Check if following
        if (!req.user.following.includes(leaderId)) {
            return res.status(400).json({
                success: false,
                message: 'Not following this leader'
            });
        }

        // Remove from following list
        req.user.following = req.user.following.filter(id => id.toString() !== leaderId);
        if (req.user.following.length === 0) {
            req.user.copyTradeSettings.enabled = false;
        }
        await req.user.save();

        // Remove from leader's followers
        const leader = await findById(leaderId);
        if (leader) {
            leader.followers = leader.followers.filter(id => id.toString() !== req.user.id);
            await leader.save();
        }

        // Unregister from copy trade service
        await copyTradeService.unregisterFollower(req.user._id.toString(), leaderId);

        res.json({
            success: true,
            message: 'Successfully unfollowed leader'
        });
    } catch (error) {
        _error('Unfollow leader error:', error);
        res.status(500).json({
            success: false,
            message: 'Error unfollowing leader'
        });
    }
}

// @desc    Get following list
// @route   GET /api/copytrade/following
// @access  Private
export async function getFollowing(req, res) {
    try {
        const user = await findById(req.user.id)
            .populate('following', 'username statistics isLeader');

        res.json({
            success: true,
            following: user.following,
            settings: user.copyTradeSettings
        });
    } catch (error) {
        _error('Get following error:', error);
        res.status(500).json({
            success: false,
            message: 'Error fetching following list'
        });
    }
}

// @desc    Get copy trade history
// @route   GET /api/copytrade/history
// @access  Private
export async function getCopyTradeHistory(req, res) {
    try {
        const { page = 1, limit = 20 } = req.query;

        const trades = await _find({
            userId: req.user.id,
            'metadata.isCopyTrade': true
        })
            .populate('metadata.copyTradeFrom', 'username')
            .sort({ createdAt: -1 })
            .limit(limit * 1)
            .skip((page - 1) * limit);

        const count = await countDocuments({
            userId: req.user.id,
            'metadata.isCopyTrade': true
        });

        // Calculate stats
        const stats = await aggregate([
            {
                $match: {
                    userId: req.user._id,
                    'metadata.isCopyTrade': true,
                    status: { $in: ['won', 'lost'] }
                }
            },
            {
                $group: {
                    _id: null,
                    totalTrades: { $sum: 1 },
                    wins: { $sum: { $cond: [{ $eq: ['$status', 'won'] }, 1, 0] } },
                    totalProfit: { $sum: '$profitLoss' }
                }
            }
        ]);

        res.json({
            success: true,
            trades,
            totalPages: Math.ceil(count / limit),
            currentPage: page,
            total: count,
            stats: stats[0] || { totalTrades: 0, wins: 0, totalProfit: 0 }
        });
    } catch (error) {
        _error('Get copy trade history error:', error);
        res.status(500).json({
            success: false,
            message: 'Error fetching copy trade history'
        });
    }
}

// @desc    Update copy trade settings
// @route   PUT /api/copytrade/settings
// @access  Private
export async function updateCopyTradeSettings(req, res) {
    try {
        const { enabled, investmentPerTrade, riskPercentage, maxDailyLoss } = req.body;

        if (enabled !== undefined) req.user.copyTradeSettings.enabled = enabled;
        if (investmentPerTrade) req.user.copyTradeSettings.investmentPerTrade = investmentPerTrade;
        if (riskPercentage) req.user.copyTradeSettings.riskPercentage = riskPercentage;
        if (maxDailyLoss) req.user.copyTradeSettings.maxDailyLoss = maxDailyLoss;

        await req.user.save();

        res.json({
            success: true,
            settings: req.user.copyTradeSettings
        });
    } catch (error) {
        _error('Update settings error:', error);
        res.status(500).json({
            success: false,
            message: 'Error updating settings'
        });
    }
}

// @desc    Apply to become a leader
// @route   POST /api/copytrade/apply-leader
// @access  Private
export async function applyLeader(req, res) {
    try {
        // Check requirements
        if (req.user.statistics.totalTrades < 50) {
            return res.status(400).json({
                success: false,
                message: 'Minimum 50 trades required to become a leader'
            });
        }

        if (req.user.statistics.winRate < 55) {
            return res.status(400).json({
                success: false,
                message: 'Minimum 55% win rate required to become a leader'
            });
        }

        if (!req.user.hasActiveSubscription() || req.user.subscription.type === 'free') {
            return res.status(403).json({
                success: false,
                message: 'Elite subscription required to become a leader'
            });
        }

        req.user.isLeader = true;
        await req.user.save();

        res.json({
            success: true,
            message: 'Congratulations! You are now a leader'
        });
    } catch (error) {
        _error('Apply leader error:', error);
        res.status(500).json({
            success: false,
            message: 'Error applying for leader status'
        });
    }
}