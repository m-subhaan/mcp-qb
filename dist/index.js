#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
// import {
//   CallToolRequestSchema,
//   ListToolsRequestSchema,
// } from "@modelcontextprotocol/sdk/types.js";
import express from "express";
import http from "http";
import { z } from "zod";
import dotenv from "dotenv";
import open from "open";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import fetch from "node-fetch";
// Get __dirname equivalent for ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// Silence dotenv noisy output (redirect stdout temporarily)
const originalWrite = process.stdout.write;
process.stdout.write = () => true;
dotenv.config({ path: path.join(__dirname, "..", ".env") });
process.stdout.write = originalWrite;
// Config paths
const CONFIG_DIR = path.join(os.homedir(), ".quickbooks-mcp");
const CREDS_PATH = path.join(CONFIG_DIR, "credentials.json");
// Load env
const CLIENT_ID = process.env.QB_CLIENT_ID;
const CLIENT_SECRET = process.env.QB_CLIENT_SECRET;
const REDIRECT_URI = "http://localhost:3000/callback";
const QB_BASE = "https://sandbox-quickbooks.api.intuit.com/v3/company";
const REALM_ID = process.env.QB_REALM_ID;
let tokens = null;
// Save/load tokens
function saveTokens(newTokens) {
    if (!fs.existsSync(CONFIG_DIR))
        fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.writeFileSync(CREDS_PATH, JSON.stringify(newTokens, null, 2));
}
// Load saved tokens
function loadTokens() {
    if (fs.existsSync(CREDS_PATH)) {
        tokens = JSON.parse(fs.readFileSync(CREDS_PATH, "utf8"));
    }
}
// Authenticate user
async function authenticate() {
    const app = express();
    const server = http.createServer(app);
    const authUrl = `https://appcenter.intuit.com/connect/oauth2?client_id=${CLIENT_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&response_type=code&scope=com.intuit.quickbooks.accounting&state=12345`;
    console.log("Open this URL to authorize:", authUrl);
    open(authUrl);
    return new Promise((resolve, reject) => {
        app.get("/callback", async (req, res) => {
            const code = req.query.code;
            if (!code) {
                res.send("No code provided");
                reject("No code");
                return;
            }
            try {
                const resp = await fetch("https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer", {
                    method: "POST",
                    headers: {
                        Authorization: "Basic " +
                            Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64"),
                        "Content-Type": "application/x-www-form-urlencoded",
                    },
                    body: `grant_type=authorization_code&code=${code}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}`,
                });
                const data = await resp.json();
                tokens = data;
                saveTokens(tokens);
                res.send("Authentication successful! You can close this window.");
                server.close();
                resolve();
            }
            catch (err) {
                reject(err);
            }
        });
        server.listen(3000, () => console.log("Listening on 3000 for callback"));
    });
}
// QuickBooks API helper
async function qbRequest(endpoint) {
    if (!tokens?.access_token)
        throw new Error("Not authenticated. Run auth first.");
    const url = `${QB_BASE}/${REALM_ID}/${endpoint}?minorversion=75`;
    console.error(`[QB] Requesting: ${url}`);
    const resp = await fetch(url, {
        headers: {
            Authorization: `Bearer ${tokens.access_token}`,
            Accept: "application/json",
        },
    });
    const text = await resp.text();
    console.error(`[QB] Response status: ${resp.status}`);
    console.error(`[QB] Response body: ${text}`);
    if (!resp.ok) {
        throw new Error(`QuickBooks API error: ${resp.status} - ${text}`);
    }
    return JSON.parse(text);
}
async function main() {
    loadTokens();
    if (process.argv[2] === "auth") {
        await authenticate();
        process.exit(0);
    }
    const server = new McpServer({
        name: "quickbooks",
        version: "1.0.0",
        capabilities: { tools: {} },
    });
    // ✅ One simple tool
    server.tool("get_customer_by_id", "Fetch a QuickBooks customer by ID", {
        customerId: z.string().describe("The QuickBooks customer ID"),
    }, async ({ customerId }) => {
        const data = await qbRequest(`customer/${customerId}`);
        const customer = data.Customer;
        return {
            content: [
                {
                    type: "text",
                    text: JSON.stringify(customer, null, 2),
                },
            ],
        };
    });
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("QuickBooks MCP server running with tool: get_customer_by_id");
}
main().catch((err) => {
    console.error("Fatal:", err);
    process.exit(1);
});
