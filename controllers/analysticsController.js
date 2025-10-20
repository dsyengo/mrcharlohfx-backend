import { countDocuments, aggregate, find } from '../models/Trade';
import { countDocuments as _countDocuments, find as _find } from '../models/Bot';
import User from '../models/User';
import { error as _error } from '../utils/logger';
import { Types } from 'mongoose';

// @desc    Get dashboard analytics
// @route   GET /api/analytics/dashboard
// @access  Private
export async function getDashboard(req, res) {
    try {
        const userId = req.user.id;

        // Get overall statistics
        const totalTrades = await countDocuments({ userId });
        const activeBots = await _countDocuments({ userId, status: 'active' });

        // Get recent performance
        const recentTrades = await aggregate([
            {
                $match: {
                    userId: Types.ObjectId(userId),
                    status: { $in: ['won', 'lost'] },
                    createdAt: { $gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) }
                }
            },
            {
                $group: {
                    _id: null,
                    totalProfit: { $sum: '$profitLoss' },
                    wins: { $sum: { $cond: [{ $eq: ['$status', 'won'] }, 1, 0] } },
                    losses: { $sum: { $cond: [{ $eq: ['$status', 'lost'] }, 1, 0] } },
                    totalTrades: { $sum: 1 }
                }
            }
        ]);

        const stats = recentTrades[0] || {
            totalProfit: 0,
            wins: 0,
            losses: 0,
            totalTrades: 0
        };

        // Get daily profit/loss chart data
        const dailyData = await aggregate([
            {
                $match: {
                    userId: Types.ObjectId(userId),
                    status: { $in: ['won', 'lost'] },
                    createdAt: { $gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) }
                }
            },
            {
                $group: {
                    _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
                    profit: { $sum: '$profitLoss' },
                    trades: { $sum: 1 },
                    wins: { $sum: { $cond: [{ $eq: ['$status', 'won'] }, 1, 0] } }
                }
            },
            { $sort: { _id: 1 } }
        ]);

        // Get top performing bots
        const topBots = await _find({ userId })
            .sort({ 'performance.netProfitLoss': -1 })
            .limit(5)
            .select('name type performance status');

        res.json({
            success: true,
            dashboard: {
                overview: {
                    totalTrades,
                    activeBots,
                    balance: req.user.balance,
                    currency: req.user.currency,
                    winRate: stats.totalTrades > 0 ? (stats.wins / stats.totalTrades) * 100 : 0,
                    totalProfit: stats.totalProfit
                },
                dailyData,
                topBots,
                recentStats: stats
            }
        });
    } catch (error) {
        _error('Get dashboard error:', error);
        res.status(500).json({
            success: false,
            message: 'Error fetching dashboard analytics'
        });
    }
}

// @desc    Get trade journal
// @route   GET /api/analytics/journal
// @access  Private
export async function getTradeJournal(req, res) {
    try {
        const { page = 1, limit = 50, startDate, endDate, status, symbol } = req.query;

        const filter = { userId: req.user.id };

        if (status) filter.status = status;
        if (symbol) filter.symbol = symbol;

        if (startDate || endDate) {
            filter.createdAt = {};
            if (startDate) filter.createdAt.$gte = new Date(startDate);
            if (endDate) filter.createdAt.$lte = new Date(endDate);
        }

        const trades = await find(filter)
            .populate('botId', 'name type')
            .sort({ createdAt: -1 })
            .limit(limit * 1)
            .skip((page - 1) * limit);

        const count = await countDocuments(filter);

        res.json({
            success: true,
            trades,
            totalPages: Math.ceil(count / limit),
            currentPage: page,
            total: count
        });
    } catch (error) {
        _error('Get trade journal error:', error);
        res.status(500).json({
            success: false,
            message: 'Error fetching trade journal'
        });
    }
}

// @desc    Get performance metrics
// @route   GET /api/analytics/performance
// @access  Private
export async function getPerformanceMetrics(req, res) {
    try {
        const { period = '30' } = req.query;
        const days = parseInt(period);
        const userId = req.user.id;

        const startDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

        // Overall metrics
        const metrics = await aggregate([
            {
                $match: {
                    userId: Types.ObjectId(userId),
                    status: { $in: ['won', 'lost'] },
                    createdAt: { $gte: startDate }
                }
            },
            {
                $group: {
                    _id: null,
                    totalTrades: { $sum: 1 },
                    wins: { $sum: { $cond: [{ $eq: ['$status', 'won'] }, 1, 0] } },
                    losses: { $sum: { $cond: [{ $eq: ['$status', 'lost'] }, 1, 0] } },
                    totalProfit: { $sum: { $cond: [{ $eq: ['$status', 'won'] }, '$profitLoss', 0] } },
                    totalLoss: { $sum: { $cond: [{ $eq: ['$status', 'lost'] }, { $abs: '$profitLoss' }, 0] } },
                    avgWin: {
                        $avg: { $cond: [{ $eq: ['$status', 'won'] }, '$profitLoss', null] }
                    },
                    avgLoss: {
                        $avg: { $cond: [{ $eq: ['$status', 'lost'] }, { $abs: '$profitLoss' }, null] }
                    },
                    maxWin: { $max: '$profitLoss' },
                    maxLoss: { $min: '$profitLoss' }
                }
            }
        ]);

        const data = metrics[0] || {};

        const winRate = data.totalTrades > 0 ? (data.wins / data.totalTrades) * 100 : 0;
        const profitFactor = data.totalLoss > 0 ? data.totalProfit / data.totalLoss : 0;
        const netProfit = (data.totalProfit || 0) - (data.totalLoss || 0);

        // Performance by symbol
        const bySymbol = await aggregate([
            {
                $match: {
                    userId: Types.ObjectId(userId),
                    status: { $in: ['won', 'lost'] },
                    createdAt: { $gte: startDate }
                }
            },
            {
                $group: {
                    _id: '$symbol',
                    trades: { $sum: 1 },
                    wins: { $sum: { $cond: [{ $eq: ['$status', 'won'] }, 1, 0] } },
                    profit: { $sum: '$profitLoss' }
                }
            },
            {
                $project: {
                    symbol: '$_id',
                    trades: 1,
                    wins: 1,
                    winRate: { $multiply: [{ $divide: ['$wins', '$trades'] }, 100] },
                    profit: 1
                }
            },
            { $sort: { profit: -1 } }
        ]);

        // Performance by contract type
        const byContractType = await aggregate([
            {
                $match: {
                    userId: Types.ObjectId(userId),
                    status: { $in: ['won', 'lost'] },
                    createdAt: { $gte: startDate }
                }
            },
            {
                $group: {
                    _id: '$contractType',
                    trades: { $sum: 1 },
                    wins: { $sum: { $cond: [{ $eq: ['$status', 'won'] }, 1, 0] } },
                    profit: { $sum: '$profitLoss' }
                }
            },
            {
                $project: {
                    contractType: '$_id',
                    trades: 1,
                    wins: 1,
                    winRate: { $multiply: [{ $divide: ['$wins', '$trades'] }, 100] },
                    profit: 1
                }
            }
        ]);

        res.json({
            success: true,
            period: `${days} days`,
            metrics: {
                totalTrades: data.totalTrades || 0,
                wins: data.wins || 0,
                losses: data.losses || 0,
                winRate: winRate.toFixed(2),
                totalProfit: data.totalProfit || 0,
                totalLoss: data.totalLoss || 0,
                netProfit,
                profitFactor: profitFactor.toFixed(2),
                avgWin: data.avgWin || 0,
                avgLoss: data.avgLoss || 0,
                maxWin: data.maxWin || 0,
                maxLoss: data.maxLoss || 0,
                expectancy: data.totalTrades > 0 ? netProfit / data.totalTrades : 0
            },
            bySymbol,
            byContractType
        });
    } catch (error) {
        _error('Get performance metrics error:', error);
        res.status(500).json({
            success: false,
            message: 'Error fetching performance metrics'
        });
    }
}

// @desc    Get profit/loss chart data
// @route   GET /api/analytics/chart
// @access  Private
export async function getChartData(req, res) {
    try {
        const { period = '30', interval = 'daily' } = req.query;
        const days = parseInt(period);
        const startDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

        let groupFormat;
        switch (interval) {
            case 'hourly':
                groupFormat = '%Y-%m-%d %H:00';
                break;
            case 'daily':
                groupFormat = '%Y-%m-%d';
                break;
            case 'weekly':
                groupFormat = '%Y-W%V';
                break;
            case 'monthly':
                groupFormat = '%Y-%m';
                break;
            default:
                groupFormat = '%Y-%m-%d';
        }

        const chartData = await aggregate([
            {
                $match: {
                    userId: Types.ObjectId(req.user.id),
                    status: { $in: ['won', 'lost'] },
                    createdAt: { $gte: startDate }
                }
            },
            {
                $group: {
                    _id: { $dateToString: { format: groupFormat, date: '$createdAt' } },
                    profit: { $sum: '$profitLoss' },
                    trades: { $sum: 1 },
                    wins: { $sum: { $cond: [{ $eq: ['$status', 'won'] }, 1, 0] } },
                    losses: { $sum: { $cond: [{ $eq: ['$status', 'lost'] }, 1, 0] } }
                }
            },
            { $sort: { _id: 1 } }
        ]);

        // Calculate cumulative profit
        let cumulative = 0;
        const enrichedData = chartData.map(item => {
            cumulative += item.profit;
            return {
                date: item._id,
                profit: item.profit,
                cumulativeProfit: cumulative,
                trades: item.trades,
                wins: item.wins,
                losses: item.losses,
                winRate: (item.wins / item.trades) * 100
            };
        });

        res.json({
            success: true,
            period: `${days} days`,
            interval,
            data: enrichedData
        });
    } catch (error) {
        _error('Get chart data error:', error);
        res.status(500).json({
            success: false,
            message: 'Error fetching chart data'
        });
    }
}

// @desc    Export trades to CSV
// @route   GET /api/analytics/export
// @access  Private
export async function exportTrades(req, res) {
    try {
        const { startDate, endDate } = req.query;

        const filter = { userId: req.user.id };

        if (startDate || endDate) {
            filter.createdAt = {};
            if (startDate) filter.createdAt.$gte = new Date(startDate);
            if (endDate) filter.createdAt.$lte = new Date(endDate);
        }

        const trades = await find(filter)
            .populate('botId', 'name')
            .sort({ createdAt: -1 });

        // Generate CSV
        const csvHeader = 'Date,Symbol,Contract Type,Entry Price,Exit Price,Stake,Payout,Profit/Loss,Status,Bot,Duration\n';
        const csvRows = trades.map(trade => {
            return `${trade.createdAt.toISOString()},${trade.symbol},${trade.contractType},${trade.entryPrice},${trade.exitPrice || 'N/A'},${trade.stake},${trade.payout || 'N/A'},${trade.profitLoss || 0},${trade.status},${trade.botId?.name || 'Manual'},${trade.duration}${trade.durationType}`;
        }).join('\n');

        const csv = csvHeader + csvRows;

        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', 'attachment; filename=trades-export.csv');
        res.send(csv);
    } catch (error) {
        _error('Export trades error:', error);
        res.status(500).json({
            success: false,
            message: 'Error exporting trades'
        });
    }
}