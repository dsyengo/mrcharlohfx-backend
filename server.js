import express from "express";
import session from "express-session";
import fetch from "node-fetch";
import cors from "cors";
import dotenv from "dotenv"

dotenv.config()

const app = express();
const PORT = 5000;

// Replace these with your Deriv App credentials
const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;
const REDIRECT_URI = "http://localhost:5000/auth";

app.use(cors({
    origin: "http://localhost:5173", // React dev server
    credentials: true
}));
app.use(express.json());
app.use(session({
    secret: "mrchalohfx-secret",
    resave: false,
    saveUninitialized: true
}));

// OAuth Step 1: Redirect user to Deriv login
app.get("/login", (req, res) => {
    const url = `https://oauth.deriv.com/oauth2/authorize?app_id=${CLIENT_ID}&redirect_uri=${REDIRECT_URI}`;
    res.redirect(url);
});

// OAuth Step 2: Handle Deriv redirect
app.get("/auth", async (req, res) => {
    const { code } = req.query;
    if (!code) return res.send("Error: no code");

    const tokenRes = await fetch("https://oauth.deriv.com/oauth2/token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            grant_type: "authorization_code",
            code,
            redirect_uri: REDIRECT_URI,
            client_id: CLIENT_ID,
            client_secret: CLIENT_SECRET
        })
    });

    const tokenData = await tokenRes.json();
    req.session.token = tokenData.access_token;

    // Redirect back to frontend
    res.redirect("http://localhost:5173/dashboard");
});

// Protected API route for Dashboard data
app.get("/api/dashboard", async (req, res) => {
    if (!req.session.token) return res.status(401).json({ error: "Not logged in" });

    const token = req.session.token;

    // Authorize
    const authRes = await fetch("https://api.deriv.com/binary/v1", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ authorize: token })
    });
    const authData = await authRes.json();

    const balance = authData?.authorize?.balance || 0;
    const currency = authData?.authorize?.currency || "USD";

    res.json({ balance, currency });
});

app.listen(PORT, () => {
    console.log(`Backend running at http://localhost:${PORT}`);
});
