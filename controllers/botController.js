const Bot = require('../models/Bot');
const Trade = require('../models/Trade');
const User = require('../models/User');
const logger = require('../utils/logger');
const BotExecutor = require('../services/botExecutor');

const botExecutor = new BotExecutor();

// @desc    Create new bot
// @route   POST /api/bots
// @access  Private
exports.createBot = async (req, res) => {
    try {
        const { name, description, type, configuration } = req.body;

        // Check if user is connected to Deriv
        if (!global.derivWSManager.isConnected(req.user.id)) {
            return res.status(400).json({
                success: false,
                message: 'Not connected to Deriv. Please reconnect your account.'
            });
        }

        // Start bot execution
        await botExecutor.startBot(bot._id.toString(), req.user.id);

        bot.status = 'active';
        bot.lastExecution = new Date();
        await bot.save();

        res.json({
            success: true,
            message: 'Bot started successfully',
            bot
        });
    } catch (error) {
        logger.error('Start bot error:', error);
        res.status(500).json({
            success: false,
            message: 'Error starting bot'
        });
    }
};

// @desc    Stop bot
// @route   POST /api/bots/:id/stop
// @access  Private
exports.stopBot = async (req, res) => {
    try {
        const bot = await Bot.findOne({
            _id: req.params.id,
            userId: req.user.id
        });

        if (!bot) {
            return res.status(404).json({
                success: false,
                message: 'Bot not found'
            });
        }

        if (bot.status !== 'active') {
            return res.status(400).json({
                success: false,
                message: 'Bot is not running'
            });
        }

        // Stop bot execution
        await botExecutor.stopBot(bot._id.toString());

        bot.status = 'stopped';
        await bot.save();

        res.json({
            success: true,
            message: 'Bot stopped successfully',
            bot
        });
    } catch (error) {
        logger.error('Stop bot error:', error);
        res.status(500).json({
            success: false,
            message: 'Error stopping bot'
        });
    }
};

// @desc    Pause bot
// @route   POST /api/bots/:id/pause
// @access  Private
exports.pauseBot = async (req, res) => {
    try {
        const bot = await Bot.findOne({
            _id: req.params.id,
            userId: req.user.id
        });

        if (!bot) {
            return res.status(404).json({
                success: false,
                message: 'Bot not found'
            });
        }

        await botExecutor.pauseBot(bot._id.toString());

        bot.status = 'paused';
        await bot.save();

        res.json({
            success: true,
            message: 'Bot paused successfully',
            bot
        });
    } catch (error) {
        logger.error('Pause bot error:', error);
        res.status(500).json({
            success: false,
            message: 'Error pausing bot'
        });
    }
};

// @desc    Get bot performance
// @route   GET /api/bots/:id/performance
// @access  Private
exports.getBotPerformance = async (req, res) => {
    try {
        const bot = await Bot.findOne({
            _id: req.params.id,
            userId: req.user.id
        });

        if (!bot) {
            return res.status(404).json({
                success: false,
                message: 'Bot not found'
            });
        }

        // Get recent trades
        const trades = await Trade.find({
            botId: bot._id,
            status: { $in: ['won', 'lost'] }
        })
            .sort({ createdAt: -1 })
            .limit(100);

        // Calculate additional metrics
        const dailyStats = await Trade.aggregate([
            {
                $match: {
                    botId: bot._id,
                    status: { $in: ['won', 'lost'] },
                    createdAt: { $gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) }
                }
            },
            {
                $group: {
                    _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
                    trades: { $sum: 1 },
                    profit: { $sum: '$profitLoss' },
                    wins: {
                        $sum: { $cond: [{ $eq: ['$status', 'won'] }, 1, 0] }
                    }
                }
            },
            { $sort: { _id: 1 } }
        ]);

        res.json({
            success: true,
            performance: bot.performance,
            recentTrades: trades,
            dailyStats
        });
    } catch (error) {
        logger.error('Get bot performance error:', error);
        res.status(500).json({
            success: false,
            message: 'Error fetching bot performance'
        });
    }
};

// @desc    Get bot trades
// @route   GET /api/bots/:id/trades
// @access  Private
exports.getBotTrades = async (req, res) => {
    try {
        const { page = 1, limit = 20, status } = req.query;

        const bot = await Bot.findOne({
            _id: req.params.id,
            userId: req.user.id
        });

        if (!bot) {
            return res.status(404).json({
                success: false,
                message: 'Bot not found'
            });
        }

        const filter = { botId: bot._id };
        if (status) filter.status = status;

        const trades = await Trade.find(filter)
            .sort({ createdAt: -1 })
            .limit(limit * 1)
            .skip((page - 1) * limit);

        const count = await Trade.countDocuments(filter);

        res.json({
            success: true,
            trades,
            totalPages: Math.ceil(count / limit),
            currentPage: page,
            total: count
        });
    } catch (error) {
        logger.error('Get bot trades error:', error);
        res.status(500).json({
            success: false,
            message: 'Error fetching bot trades'
        });
    }
}; if elite bot and user has subscription
if (type === 'elite_speedbot') {
    if (!req.user.hasActiveSubscription() || req.user.subscription.type === 'free') {
        return res.status(403).json({
            success: false,
            message: 'Elite subscription required for SpeedBots'
        });
    }
}

// Check bot limit
const botCount = await Bot.countDocuments({ userId: req.user.id, status: { $ne: 'stopped' } });
const maxBots = req.user.subscription.type === 'elite' ? 10 : 3;

if (botCount >= maxBots) {
    return res.status(400).json({
        success: false,
        message: `Maximum bot limit reached (${maxBots})`
    });
}

const bot = await Bot.create({
    userId: req.user.id,
    name,
    description,
    type,
    configuration,
    isElite: type === 'elite_speedbot'
});

res.status(201).json({
    success: true,
    bot
});
  } catch (error) {
    logger.error('Create bot error:', error);
    res.status(500).json({
        success: false,
        message: 'Error creating bot'
    });
}
};

// @desc    Get all user bots
// @route   GET /api/bots
// @access  Private
exports.getBots = async (req, res) => {
    try {
        const { status, type } = req.query;

        const filter = { userId: req.user.id };
        if (status) filter.status = status;
        if (type) filter.type = type;

        const bots = await Bot.find(filter).sort({ createdAt: -1 });

        res.json({
            success: true,
            count: bots.length,
            bots
        });
    } catch (error) {
        logger.error('Get bots error:', error);
        res.status(500).json({
            success: false,
            message: 'Error fetching bots'
        });
    }
};

// @desc    Get single bot
// @route   GET /api/bots/:id
// @access  Private
exports.getBot = async (req, res) => {
    try {
        const bot = await Bot.findOne({
            _id: req.params.id,
            userId: req.user.id
        });

        if (!bot) {
            return res.status(404).json({
                success: false,
                message: 'Bot not found'
            });
        }

        res.json({
            success: true,
            bot
        });
    } catch (error) {
        logger.error('Get bot error:', error);
        res.status(500).json({
            success: false,
            message: 'Error fetching bot'
        });
    }
};

// @desc    Update bot
// @route   PUT /api/bots/:id
// @access  Private
exports.updateBot = async (req, res) => {
    try {
        const { name, description, configuration } = req.body;

        let bot = await Bot.findOne({
            _id: req.params.id,
            userId: req.user.id
        });

        if (!bot) {
            return res.status(404).json({
                success: false,
                message: 'Bot not found'
            });
        }

        // Can't update active bot
        if (bot.status === 'active') {
            return res.status(400).json({
                success: false,
                message: 'Stop bot before updating'
            });
        }

        if (name) bot.name = name;
        if (description) bot.description = description;
        if (configuration) bot.configuration = { ...bot.configuration, ...configuration };

        await bot.save();

        res.json({
            success: true,
            bot
        });
    } catch (error) {
        logger.error('Update bot error:', error);
        res.status(500).json({
            success: false,
            message: 'Error updating bot'
        });
    }
};

// @desc    Delete bot
// @route   DELETE /api/bots/:id
// @access  Private
exports.deleteBot = async (req, res) => {
    try {
        const bot = await Bot.findOne({
            _id: req.params.id,
            userId: req.user.id
        });

        if (!bot) {
            return res.status(404).json({
                success: false,
                message: 'Bot not found'
            });
        }

        // Stop bot first
        if (bot.status === 'active') {
            await botExecutor.stopBot(bot._id.toString());
        }

        await bot.deleteOne();

        res.json({
            success: true,
            message: 'Bot deleted successfully'
        });
    } catch (error) {
        logger.error('Delete bot error:', error);
        res.status(500).json({
            success: false,
            message: 'Error deleting bot'
        });
    }
};

// @desc    Start bot
// @route   POST /api/bots/:id/start
// @access  Private
exports.startBot = async (req, res) => {
    try {
        const bot = await Bot.findOne({
            _id: req.params.id,
            userId: req.user.id
        });

        if (!bot) {
            return res.status(404).json({
                success: false,
                message: 'Bot not found'
            });
        }

        if (bot.status === 'active') {
            return res.status(400).json({
                success: false,
                message: 'Bot is already running'
            });
        }

// Check