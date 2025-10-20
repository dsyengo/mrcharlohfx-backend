import express from "express";
import { createProxyMiddleware } from "http-proxy-middleware";
import helmet from "helmet";
import cors from "cors";

const app = express();

// --- Secure defaults ---
app.use(helmet());
app.use(cors());

// --- Allow your domain to embed the proxied page ---
app.use((req, res, next) => {
    res.setHeader(
        "Content-Security-Policy",
        "frame-ancestors 'self' https://mrcharlohfx-backend.onrender.com"
    );
    next();
});

// --- Reverse Proxy for Deriv pages ---
app.use(
    "/deriv",
    createProxyMiddleware({
        target: "https://dbot.deriv.com",
        changeOrigin: true,
        pathRewrite: { "^/deriv": "" },
        onProxyRes(proxyRes, req, res) {
            // Remove headers that would block embedding
            delete proxyRes.headers["x-frame-options"];
            delete proxyRes.headers["content-security-policy"];
        },
    })
);

// --- Start server ---
app.listen(5000, () => {
    console.log("✅ Reverse proxy running at http://localhost:5000");
});
