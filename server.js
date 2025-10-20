import express from "express";
import { createProxyMiddleware } from "http-proxy-middleware";
import helmet from "helmet";
import cors from "cors";

const app = express();
app.use(helmet());
app.use(cors());

// --- Reverse Proxy for Deriv Dbot pages ---
app.use(
    "/deriv",
    createProxyMiddleware({
        target: "https://dbot.deriv.com",
        changeOrigin: true,
        pathRewrite: { "^/deriv": "" },
        onProxyRes(proxyRes, req, res) {
            // remove headers that block embedding
            delete proxyRes.headers["x-frame-options"];
            delete proxyRes.headers["content-security-policy"];
        },
    })
);

app.listen(5000, () => console.log("Reverse proxy running at http://localhost:5000"));
