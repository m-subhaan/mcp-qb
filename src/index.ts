#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
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
const CLIENT_ID = process.env.QB_CLIENT_ID!;
const CLIENT_SECRET = process.env.QB_CLIENT_SECRET!;
const REDIRECT_URI = "http://localhost:3000/callback";
const QB_BASE = "https://sandbox-quickbooks.api.intuit.com/v3/company";
const REALM_ID = process.env.QB_REALM_ID!;

// Use a supported minor version (>=75)
const MINOR_VERSION = 75;

let tokens: Record<string, any> | null = null;

// Save/load tokens
function saveTokens(newTokens: any) {
  if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CREDS_PATH, JSON.stringify(newTokens, null, 2));
}

// Load saved tokens
function loadTokens() {
  if (fs.existsSync(CREDS_PATH)) {
    tokens = JSON.parse(fs.readFileSync(CREDS_PATH, "utf8"));
  }
}

// --- OAuth2 helpers ---

async function refreshTokens(): Promise<void> {
  if (!tokens?.refresh_token) {
    throw new Error("No refresh_token available; re-authentication required.");
  }
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: tokens.refresh_token,
  });

  const resp = await fetch(
    "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer",
    {
      method: "POST",
      headers: {
        Authorization:
          "Basic " +
          Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64"),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
    }
  );

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Token refresh failed: ${resp.status} - ${text}`);
  }

  const data = (await resp.json()) as Record<string, any>;
  // Guard tokens (could be null) and assert merged object type
  tokens = { ...(tokens ?? {}), ...(data ?? {}) } as Record<string, any>;
  saveTokens(tokens);
}

// Authenticate user
async function authenticate() {
  const app = express();
  const server = http.createServer(app);

  const authUrl = `https://appcenter.intuit.com/connect/oauth2?client_id=${CLIENT_ID}&redirect_uri=${encodeURIComponent(
    REDIRECT_URI
  )}&response_type=code&scope=com.intuit.quickbooks.accounting&state=12345`;

  console.log("Open this URL to authorize:", authUrl);
  open(authUrl);

  return new Promise<void>((resolve, reject) => {
    app.get("/callback", async (req, res) => {
      const code = req.query.code as string;
      if (!code) {
        res.send("No code provided");
        reject("No code");
        return;
      }

      try {
        const resp = await fetch(
          "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer",
          {
            method: "POST",
            headers: {
              Authorization:
                "Basic " +
                Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64"),
              "Content-Type": "application/x-www-form-urlencoded",
            },
            body: `grant_type=authorization_code&code=${encodeURIComponent(
              code
            )}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}`,
          }
        );

        const data = await resp.json();
        tokens = data as Record<string, any>;
        saveTokens(tokens);

        res.send("Authentication successful! You can close this window.");
        server.close();
        resolve();
      } catch (err) {
        reject(err);
      }
    });

    server.listen(3000, () => console.log("Listening on 3000 for callback"));
  });
}

// --- QuickBooks API helpers ---

type QbOptions = {
  method?: "GET" | "POST";
  body?: any;
  headers?: Record<string, string>;
};

/**
 * Core request helper. Appends minorversion correctly for both /resource and /query?query=... endpoints.
 * Also auto-refreshes tokens once on 401.
 */
async function qbRequest(endpoint: string, options: QbOptions = {}): Promise<any> {
  if (!tokens?.access_token) throw new Error("Not authenticated. Run auth first.");

  const baseUrl = `${QB_BASE}/${REALM_ID}/${endpoint}`;
  const url =
    baseUrl + (baseUrl.includes("?") ? `&minorversion=${MINOR_VERSION}` : `?minorversion=${MINOR_VERSION}`);

  const doFetch = async () => {
    console.error(`[QB] Requesting: ${url}`);
    const resp = await fetch(url, {
      method: options.method ?? "GET",
      headers: {
        Authorization: `Bearer ${tokens!.access_token}`,
        Accept: "application/json",
        ...(options.body ? { "Content-Type": "application/json" } : {}),
        ...(options.headers ?? {}),
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
    });

    const text = await resp.text();
    console.error(`[QB] Response status: ${resp.status}`);
    console.error(`[QB] Response body: ${text}`);

    if (!resp.ok) {
      // 401 -> try refresh once
      if (resp.status === 401) {
        return { needRefresh: true, text };
      }
      throw new Error(`QuickBooks API error: ${resp.status} - ${text}`);
    }

    return JSON.parse(text || "{}");
  };

  let result = await doFetch();
  if (result?.needRefresh) {
    await refreshTokens();
    result = await doFetch();
    if (result?.needRefresh) {
      throw new Error("Unauthorized after token refresh.");
    }
  }
  return result;
}

// Simple query helper
async function qbQuery(sql: string): Promise<any> {
  const q = encodeURIComponent(sql);
  return qbRequest(`query?query=${q}`, { method: "GET" });
}

// Fetch latest entity to get SyncToken (needed for updates)
async function getCustomerRaw(id: string): Promise<any> {
  const data = await qbRequest(`customer/${id}`, { method: "GET" });
  return data?.Customer;
}

// Fetch latest Account (for SyncToken on update)
async function getAccountRaw(id: string): Promise<any> {
  const data = await qbRequest(`account/${id}`, { method: "GET" });
  return data?.Account;
}

// Map simplified input to QBO Customer shape
function mapCustomerInputToQBO(input: any) {
  const qbo: any = {};

  if (input.displayName) qbo.DisplayName = input.displayName;
  if (input.companyName) qbo.CompanyName = input.companyName;
  if (input.title) qbo.Title = input.title;
  if (input.givenName) qbo.GivenName = input.givenName;
  if (input.middleName) qbo.MiddleName = input.middleName;
  if (input.familyName) qbo.FamilyName = input.familyName;
  if (input.suffix) qbo.Suffix = input.suffix;
  if (typeof input.taxExempt === "boolean") qbo.Taxable = !input.taxExempt;
  if (input.notes) qbo.Notes = input.notes;

  if (input.primaryEmail) qbo.PrimaryEmailAddr = { Address: input.primaryEmail };
  if (input.primaryPhone) qbo.PrimaryPhone = { FreeFormNumber: input.primaryPhone };
  if (input.mobilePhone) qbo.Mobile = { FreeFormNumber: input.mobilePhone };
  if (input.fax) qbo.Fax = { FreeFormNumber: input.fax };

  if (input.billAddr) {
    const b = input.billAddr;
    qbo.BillAddr = {
      Line1: b.line1,
      Line2: b.line2,
      City: b.city,
      CountrySubDivisionCode: b.countrySubDivisionCode,
      PostalCode: b.postalCode,
      Country: b.country,
    };
  }

  if (input.shipAddr) {
    const s = input.shipAddr;
    qbo.ShipAddr = {
      Line1: s.line1,
      Line2: s.line2,
      City: s.city,
      CountrySubDivisionCode: s.countrySubDivisionCode,
      PostalCode: s.postalCode,
      Country: s.country,
    };
  }

  return qbo;
}

// Map simplified input to QBO Account shape
function mapAccountInputToQBO(input: any) {
  const qbo: any = {};

  // Commonly used Account fields
  if (input.name) qbo.Name = input.name;
  if (input.fullyQualifiedName) qbo.FullyQualifiedName = input.fullyQualifiedName;
  if (input.accountType) qbo.AccountType = input.accountType;           // e.g., "Bank", "Accounts Receivable", ...
  if (input.accountSubType) qbo.AccountSubType = input.accountSubType;  // e.g., "Checking", "AccountsReceivable", ...
  if (input.description) qbo.Description = input.description;
  if (input.classification) qbo.Classification = input.classification;  // e.g., "Asset", "Liability", "Equity", "Income", "Expense"
  if (input.accountNumber) qbo.AcctNum = input.accountNumber;
  if (typeof input.taxCodeRef === "string") qbo.TaxCodeRef = { value: input.taxCodeRef };
  if (input.currencyRef) qbo.CurrencyRef = { value: input.currencyRef }; // e.g., "USD"
  if (typeof input.subAccount === "boolean") qbo.SubAccount = input.subAccount;
  if (input.parentRef) qbo.ParentRef = { value: input.parentRef }; // parent Account.Id
  if (typeof input.currentBalance === "number") qbo.CurrentBalance = input.currentBalance; // usually read-only; avoid on create
  if (typeof input.active === "boolean") qbo.Active = input.active;

  return qbo;
}

// --- Zod Schemas ---

const paginationSchema = z.object({
  startPosition: z.number().int().min(1).default(1).describe("Query start position (1-based)"),
  maxResults: z.number().int().min(1).max(1000).default(50).describe("Max results (1-1000)"),
});

const accountPaginationSchema = z.object({
  startPosition: z.number().int().min(1).default(1),
  maxResults: z.number().int().min(1).max(1000).default(50),
});

// For create (DisplayName required)
const customerCreateSchema = z.object({
  displayName: z.string().min(1).describe("Customer DisplayName"),
  title: z.string().optional(),
  givenName: z.string().optional(),
  middleName: z.string().optional(),
  familyName: z.string().optional(),
  suffix: z.string().optional(),
  companyName: z.string().optional(),
  primaryEmail: z.string().email().optional(),
  primaryPhone: z.string().optional(),
  mobilePhone: z.string().optional(),
  fax: z.string().optional(),
  notes: z.string().optional(),
  taxExempt: z.boolean().optional(),
  billAddr: z
    .object({
      line1: z.string().optional(),
      line2: z.string().optional(),
      city: z.string().optional(),
      countrySubDivisionCode: z.string().optional(),
      postalCode: z.string().optional(),
      country: z.string().optional(),
    })
    .optional(),
  shipAddr: z
    .object({
      line1: z.string().optional(),
      line2: z.string().optional(),
      city: z.string().optional(),
      countrySubDivisionCode: z.string().optional(),
      postalCode: z.string().optional(),
      country: z.string().optional(),
    })
    .optional(),
});

// For update (all fields optional except customerId, sparse)
const customerUpdateParams = {
  customerId: z.string().min(1).describe("Customer Id for update"),
  sparse: z.boolean().default(true).describe("Perform sparse update (recommended)"),
  displayName: z.string().optional(),
  title: z.string().optional(),
  givenName: z.string().optional(),
  middleName: z.string().optional(),
  familyName: z.string().optional(),
  suffix: z.string().optional(),
  companyName: z.string().optional(),
  primaryEmail: z.string().email().optional(),
  primaryPhone: z.string().optional(),
  mobilePhone: z.string().optional(),
  fax: z.string().optional(),
  notes: z.string().optional(),
  taxExempt: z.boolean().optional(),
  billAddr: z
    .object({
      line1: z.string().optional(),
      line2: z.string().optional(),
      city: z.string().optional(),
      countrySubDivisionCode: z.string().optional(),
      postalCode: z.string().optional(),
      country: z.string().optional(),
    })
    .optional(),
  shipAddr: z
    .object({
      line1: z.string().optional(),
      line2: z.string().optional(),
      city: z.string().optional(),
      countrySubDivisionCode: z.string().optional(),
      postalCode: z.string().optional(),
      country: z.string().optional(),
    })
    .optional(),
};

const searchSchema = z.object({
  startPosition: paginationSchema.shape.startPosition,
  maxResults: paginationSchema.shape.maxResults,
  displayName: z.string().optional(),
  companyName: z.string().optional(),
  givenName: z.string().optional(),
  familyName: z.string().optional(),
  email: z.string().optional(),
  phone: z.string().optional(),
  activeOnly: z.boolean().default(true),
  orderBy: z.enum(["Id", "DisplayName", "Metadata.LastUpdatedTime"]).default("Metadata.LastUpdatedTime"),
  sort: z.enum(["ASC", "DESC"]).default("DESC"),
});

const accountCreateSchema = z.object({
  name: z.string().min(1).describe("Account Name"),
  accountType: z.string().min(1).describe("QBO AccountType (e.g., Bank, Accounts Receivable, Income, Expense)"),
  accountSubType: z.string().optional().describe("QBO AccountSubType (e.g., Checking, AccountsReceivable)"),
  description: z.string().optional(),
  classification: z.string().optional().describe("Asset | Liability | Equity | Income | Expense"),
  accountNumber: z.string().optional(),
  currencyRef: z.string().optional().describe("ISO currency code (e.g., USD)"),
  subAccount: z.boolean().optional(),
  parentRef: z.string().optional().describe("Parent Account Id (only if subAccount=true)"),
  taxCodeRef: z.string().optional(),
  active: z.boolean().optional(),
});

const accountUpdateSchema = z.object({
  accountId: z.string().min(1).describe("Account Id to update"),
  sparse: z.boolean().default(true),
  name: z.string().optional(),
  accountType: z.string().optional(),
  accountSubType: z.string().optional(),
  description: z.string().optional(),
  classification: z.string().optional(),
  accountNumber: z.string().optional(),
  currencyRef: z.string().optional(),
  subAccount: z.boolean().optional(),
  parentRef: z.string().optional(),
  taxCodeRef: z.string().optional(),
  active: z.boolean().optional(),
});

const accountSearchSchema = z.object({
  startPosition: accountPaginationSchema.shape.startPosition,
  maxResults: accountPaginationSchema.shape.maxResults,
  name: z.string().optional(),
  accountType: z.string().optional(),
  accountSubType: z.string().optional(),
  classification: z.string().optional(),
  activeOnly: z.boolean().default(true),
  orderBy: z
    .enum(["Id", "Name", "FullyQualifiedName", "Metadata.LastUpdatedTime"])
    .default("Metadata.LastUpdatedTime"),
  sort: z.enum(["ASC", "DESC"]).default("DESC"),
});

// --- MAIN ---

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

  // ✅ Existing tool: Get customer by ID (unchanged)
  server.tool(
    "get_customer_by_id",
    "Fetch a QuickBooks customer by ID",
    {
      customerId: z.string().describe("The QuickBooks customer ID"),
    },
    async ({ customerId }) => {
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
    }
  );

  // ✅ List customers (paged) using SQL-like query
  server.tool(
    "list_customers",
    "List customers with pagination (uses QBO query endpoint)",
    paginationSchema.shape,
    async ({ startPosition, maxResults }) => {
      // NOTE: QBO query uses "ORDER BY" with a space
      const sql = `SELECT * FROM Customer ORDER BY Metadata.LastUpdatedTime DESC STARTPOSITION ${startPosition} MAXRESULTS ${maxResults}`;
      const data = await qbQuery(sql);
      const customers = data?.QueryResponse?.Customer ?? [];

      return {
        content: [{ type: "text", text: JSON.stringify(customers, null, 2) }],
      };
    }
  );

  // ✅ Search customers by common fields (DisplayName, Given/Family, Email, Phone)
  server.tool(
    "search_customers",
    "Search customers by name/email/phone with optional pagination",
    searchSchema.shape,
    async ({
      displayName,
      companyName,
      givenName,
      familyName,
      email,
      phone,
      activeOnly,
      startPosition,
      maxResults,
      orderBy,
      sort,
    }) => {
      const conditions: string[] = [];
      if (typeof activeOnly === "boolean") {
        conditions.push(`Active = ${activeOnly ? "true" : "false"}`);
      }
      const esc = (s: string) => s.replace(/'/g, "\\'");
      if (displayName) conditions.push(`DisplayName LIKE '${esc(displayName)}%'`);
      if (companyName) conditions.push(`CompanyName LIKE '${esc(companyName)}%'`);
      if (givenName) conditions.push(`GivenName LIKE '${esc(givenName)}%'`);
      if (familyName) conditions.push(`FamilyName LIKE '${esc(familyName)}%'`);
      if (email) conditions.push(`PrimaryEmailAddr.Address LIKE '${esc(email)}%'`);
      if (phone) conditions.push(`PrimaryPhone.FreeFormNumber LIKE '${esc(phone)}%'`);

      const where = conditions.length ? ` WHERE ${conditions.join(" AND ")}` : "";
      const sql = `SELECT * FROM Customer${where} ORDER BY ${orderBy} ${sort} STARTPOSITION ${startPosition} MAXRESULTS ${maxResults}`;
      const data = await qbQuery(sql);
      const customers = data?.QueryResponse?.Customer ?? [];

      return {
        content: [{ type: "text", text: JSON.stringify(customers, null, 2) }],
      };
    }
  );

  // ✅ Create a new customer
  server.tool(
    "create_customer",
    "Create a new QuickBooks customer",
    customerCreateSchema.shape,
    async (input) => {
      const body = mapCustomerInputToQBO(input);
      const data = await qbRequest("customer", { method: "POST", body });
      const created = data?.Customer ?? data;
      return {
        content: [{ type: "text", text: JSON.stringify(created, null, 2) }],
      };
    }
  );

  // ✅ Update an existing customer (sparse by default)
  server.tool(
    "update_customer",
    "Update an existing QuickBooks customer (uses sparse update by default)",
    customerUpdateParams,
    async (input) => {
      const { customerId, sparse = true, ...patch } = input as any;

      // get latest SyncToken
      const existing = await getCustomerRaw(customerId);
      if (!existing?.Id || existing.SyncToken === undefined) {
        throw new Error("Could not fetch existing customer or SyncToken.");
      }

      const body = {
        Id: existing.Id,
        SyncToken: existing.SyncToken,
        ...(sparse ? { sparse: true } : {}),
        ...mapCustomerInputToQBO(patch),
      };

      const data = await qbRequest("customer?operation=update", { method: "POST", body });
      const updated = data?.Customer ?? data;
      return {
        content: [{ type: "text", text: JSON.stringify(updated, null, 2) }],
      };
    }
  );

  // ✅ Activate/Deactivate (QBO typically uses Active flag instead of hard delete)
  server.tool(
    "set_customer_active",
    "Activate or deactivate a customer (Active=true/false)",
    {
      customerId: z.string().describe("Customer Id"),
      active: z.boolean().describe("Set Active true/false"),
    },
    async ({ customerId, active }) => {
      const existing = await getCustomerRaw(customerId);
      if (!existing?.Id || existing.SyncToken === undefined) {
        throw new Error("Could not fetch existing customer or SyncToken.");
      }

      const body = {
        Id: existing.Id,
        SyncToken: existing.SyncToken,
        sparse: true,
        Active: active,
      };

      const data = await qbRequest("customer?operation=update", { method: "POST", body });
      const updated = data?.Customer ?? data;
      return {
        content: [{ type: "text", text: JSON.stringify(updated, null, 2) }],
      };
    }
  );

  // ✅ Find single customer by exact DisplayName (handy for dedupe flows)
  server.tool(
    "get_customer_by_display_name",
    "Fetch a single customer whose DisplayName matches exactly",
    { displayName: z.string().min(1) },
    async ({ displayName }) => {
      const safe = displayName.replace(/'/g, "\\'");
      const sql = `SELECT * FROM Customer WHERE DisplayName = '${safe}'`;
      const data = await qbQuery(sql);
      const customers = data?.QueryResponse?.Customer ?? [];
      const hit = customers[0] ?? null;
      return {
        content: [{ type: "text", text: JSON.stringify(hit, null, 2) }],
      };
    }
  );

  server.tool(
    "get_account_by_id",
    "Fetch a QuickBooks account by ID",
    { accountId: z.string().describe("The QuickBooks Account ID") },
    async ({ accountId }) => {
      const data = await qbRequest(`account/${accountId}`, { method: "GET" });
      const account = data?.Account ?? data;
      return { content: [{ type: "text", text: JSON.stringify(account, null, 2) }] };
    }
  );
  
  // List accounts (paged)
  server.tool(
    "list_accounts",
    "List accounts with pagination (uses QBO query endpoint)",
    accountPaginationSchema.shape,
    async ({ startPosition, maxResults }) => {
      const sql = `SELECT * FROM Account ORDER BY Metadata.LastUpdatedTime DESC STARTPOSITION ${startPosition} MAXRESULTS ${maxResults}`;
      const data = await qbQuery(sql);
      const accounts = data?.QueryResponse?.Account ?? [];
      return { content: [{ type: "text", text: JSON.stringify(accounts, null, 2) }] };
    }
  );
  
  // Search accounts
  server.tool(
    "search_accounts",
    "Search accounts by name/type/subtype/classification with optional pagination",
    accountSearchSchema.shape,
    async ({ name, accountType, accountSubType, classification, activeOnly, startPosition, maxResults, orderBy, sort }) => {
      const parts: string[] = [];
      const esc = (s: string) => s.replace(/'/g, "\\'");
  
      if (typeof activeOnly === "boolean") parts.push(`Active = ${activeOnly ? "true" : "false"}`);
      if (name) parts.push(`Name LIKE '${esc(name)}%'`);
      if (accountType) parts.push(`AccountType = '${esc(accountType)}'`);
      if (accountSubType) parts.push(`AccountSubType = '${esc(accountSubType)}'`);
      if (classification) parts.push(`Classification = '${esc(classification)}'`);
  
      const where = parts.length ? ` WHERE ${parts.join(" AND ")}` : "";
      const sql = `SELECT * FROM Account${where} ORDER BY ${orderBy} ${sort} STARTPOSITION ${startPosition} MAXRESULTS ${maxResults}`;
      const data = await qbQuery(sql);
      const accounts = data?.QueryResponse?.Account ?? [];
      return { content: [{ type: "text", text: JSON.stringify(accounts, null, 2) }] };
    }
  );
  
  // Create account
  server.tool(
    "create_account",
    "Create a new QuickBooks account",
    accountCreateSchema.shape,
    async (input) => {
      const body = mapAccountInputToQBO(input);
      const data = await qbRequest("account", { method: "POST", body });
      const created = data?.Account ?? data;
      return { content: [{ type: "text", text: JSON.stringify(created, null, 2) }] };
    }
  );
  
  // Update account (sparse by default)
  server.tool(
    "update_account",
    "Update an existing QuickBooks account (sparse update by default)",
    accountUpdateSchema.shape,
    async (input) => {
      const { accountId, sparse = true, ...patch } = input as any;
  
      // get latest SyncToken
      const existing = await getAccountRaw(accountId);
      if (!existing?.Id || existing.SyncToken === undefined) {
        throw new Error("Could not fetch existing account or SyncToken.");
      }
  
      const body = {
        Id: existing.Id,
        SyncToken: existing.SyncToken,
        ...(sparse ? { sparse: true } : {}),
        ...mapAccountInputToQBO(patch),
      };
  
      const data = await qbRequest("account?operation=update", { method: "POST", body });
      const updated = data?.Account ?? data;
      return { content: [{ type: "text", text: JSON.stringify(updated, null, 2) }] };
    }
  );
  
  // Activate/Deactivate account
  server.tool(
    "set_account_active",
    "Activate or deactivate an account (Active=true/false)",
    {
      accountId: z.string().describe("Account Id"),
      active: z.boolean().describe("Set Active true/false"),
    },
    async ({ accountId, active }) => {
      const existing = await getAccountRaw(accountId);
      if (!existing?.Id || existing.SyncToken === undefined) {
        throw new Error("Could not fetch existing account or SyncToken.");
      }
  
      const body = {
        Id: existing.Id,
        SyncToken: existing.SyncToken,
        sparse: true,
        Active: active,
      };
  
      const data = await qbRequest("account?operation=update", { method: "POST", body });
      const updated = data?.Account ?? data;
      return { content: [{ type: "text", text: JSON.stringify(updated, null, 2) }] };
    }
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(
    "QuickBooks MCP server running"
  );
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
