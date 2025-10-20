import express from "express";
import { createProxyMiddleware } from "http-proxy-middleware";
import helmet from "helmet";
import cors from "cors";

const app = express();

app.use(helmet());
app.use(cors());

// ✅ Allow your frontend to embed this backend inside iframes
app.use((req, res, next) => {
    res.setHeader(
        "Content-Security-Policy",
        "frame-ancestors 'self' https://mrcharlohfx-frontend.onrender.com"
    );
    next();
});

// ✅ Reverse proxy for Deriv Dbot (chart or bot builder)
app.use(
    "/deriv",
    createProxyMiddleware({
        target: "https://dbot.deriv.com",
        changeOrigin: true,
        pathRewrite: { "^/deriv": "" },

        onProxyRes(proxyRes) {
            // Remove Deriv’s restrictive headers
            delete proxyRes.headers["x-frame-options"];
            delete proxyRes.headers["content-security-policy"];
            delete proxyRes.headers["content-security-policy-report-only"];
        },
    })
);

app.listen(5000, () => {
    console.log("✅ Reverse proxy running at http://localhost:5000");
});
