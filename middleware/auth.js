import { verify } from 'jsonwebtoken';
import { findById } from '../models/User';
import { error as _error } from '../utils/logger';

// Protect routes - verify JWT token
export async function protect(req, res, next) {
    try {
        let token;

        // Check for token in headers
        if (req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
            token = req.headers.authorization.split(' ')[1];
        } else if (req.cookies.token) {
            token = req.cookies.token;
        }

        if (!token) {
            return res.status(401).json({
                success: false,
                message: 'Not authorized to access this route'
            });
        }

        try {
            // Verify token
            const decoded = verify(token, process.env.JWT_SECRET);

            // Get user from database
            req.user = await findById(decoded.id);

            if (!req.user) {
                return res.status(401).json({
                    success: false,
                    message: 'User not found'
                });
            }

            if (!req.user.isActive) {
                return res.status(401).json({
                    success: false,
                    message: 'Account is deactivated'
                });
            }

            next();
        } catch (error) {
            return res.status(401).json({
                success: false,
                message: 'Invalid or expired token'
            });
        }
    } catch (error) {
        _error('Auth middleware error:', error);
        return res.status(500).json({
            success: false,
            message: 'Server error during authentication'
        });
    }
}

// Check if user has active subscription
export function requireSubscription(requiredType = 'elite') {
    return async (req, res, next) => {
        try {
            if (!req.user.hasActiveSubscription()) {
                return res.status(403).json({
                    success: false,
                    message: 'Active subscription required'
                });
            }

            if (requiredType === 'elite' && req.user.subscription.type === 'free') {
                return res.status(403).json({
                    success: false,
                    message: 'Elite subscription required for this feature'
                });
            }

            next();
        } catch (error) {
            _error('Subscription check error:', error);
            return res.status(500).json({
                success: false,
                message: 'Error checking subscription status'
            });
        }
    };
}

// Check if user is a leader (for copy trading)
export async function requireLeader(req, res, next) {
    try {
        if (!req.user.isLeader) {
            return res.status(403).json({
                success: false,
                message: 'Leader status required for this action'
            });
        }
        next();
    } catch (error) {
        _error('Leader check error:', error);
        return res.status(500).json({
            success: false,
            message: 'Error checking leader status'
        });
    }
}