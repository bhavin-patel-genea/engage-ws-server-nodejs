#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const BASE_URL = (process?.env.ENGAGE_BASE_URL || 'http://localhost:8080').replace(/\/$/, '');
// Disable TLS verification for self-signed certs (dev/local only)
if (BASE_URL.startsWith('https://localhost') || BASE_URL.startsWith('https://127.')) {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
}
console.error(`[engage-ws-mcp] BASE_URL = ${BASE_URL}`);
// ── HTTP helpers ────────────────────────────────────────────────────────────────

async function apiGet(path: string, params?: Record<string, string>) {
  const url = new URL(`${BASE_URL}${path}`);
  if (params) {
    for (const [key, val] of Object.entries(params)) {
      if (val !== undefined && val !== '') url.searchParams.set(key, val);
    }
  }
  const res = await fetch(url.toString());
  const text = await res.text();
  try {
    return { ok: res.ok, status: res.status, data: JSON.parse(text) };
  } catch {
    return { ok: res.ok, status: res.status, data: text };
  }
}

async function apiPost(path: string, body: unknown) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  try {
    return { ok: res.ok, status: res.status, data: JSON.parse(text) };
  } catch {
    return { ok: res.ok, status: res.status, data: text };
  }
}

async function apiPut(path: string, body: unknown) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  try {
    return { ok: res.ok, status: res.status, data: JSON.parse(text) };
  } catch {
    return { ok: res.ok, status: res.status, data: text };
  }
}

async function apiDelete(path: string) {
  const res = await fetch(`${BASE_URL}${path}`, { method: 'DELETE' });
  const text = await res.text();
  try {
    return { ok: res.ok, status: res.status, data: JSON.parse(text) };
  } catch {
    return { ok: res.ok, status: res.status, data: text };
  }
}

function toText(result: { ok: boolean; status: number; data: unknown }): string {
  if (!result.ok) {
    const errMsg = typeof result.data === 'object' && result.data !== null
      ? (result.data as Record<string, unknown>).error ?? JSON.stringify(result.data)
      : result.data;
    return `Error ${result.status}: ${errMsg}`;
  }
  return typeof result.data === 'string' ? result.data : JSON.stringify(result.data, null, 2);
}

// ── MCP Server ──────────────────────────────────────────────────────────────────

const server = new McpServer({
  name: 'engage-ws-server',
  version: '1.0.0',
});

// ── Health ──────────────────────────────────────────────────────────────────────

server.registerTool(
  'engage_health_check',
  {
    description: 'Check if the ENGAGE WebSocket server is running and reachable.',
    inputSchema: {},
    annotations: { readOnlyHint: true, idempotentHint: true },
  },
  async () => {
    const result = await apiGet('/engage/index');
    return { content: [{ type: 'text', text: toText(result) }] };
  },
);

// ── Connections ──────────────────────────────────────────────────────────────────

server.registerTool(
  'engage_list_connections',
  {
    description: 'List gateway connection history, reconnection gaps, and stats. Returns events (connect/disconnect timeline), history (gap durations), and aggregate stats.',
    inputSchema: {
      sn: z.string().optional().describe('Filter by gateway serial number (optional)'),
      limit: z.number().optional().describe('Max history entries to return (default 20)'),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ sn, limit }) => {
    const params: Record<string, string> = {};
    if (sn) params.sn = sn;
    if (limit) params.limit = String(limit);
    const result = await apiGet('/api/connections', params);
    return { content: [{ type: 'text', text: toText(result) }] };
  },
);

// ── Audit Log ──────────────────────────────────────────────────────────────────

server.registerTool(
  'engage_get_audit_log',
  {
    description: 'Query the 48-hour audit event log from all connected gateways. Returns access events (badge reads, door alarms, lock state changes) with event codes, device IDs, and timestamps.',
    inputSchema: {
      sn: z.string().optional().describe('Filter by gateway serial number'),
      since: z.string().optional().describe('ISO 8601 datetime — only return events after this time'),
      limit: z.number().optional().describe('Max entries to return (default 100)'),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ sn, since, limit }) => {
    const params: Record<string, string> = {};
    if (sn) params.sn = sn;
    if (since) params.since = since;
    if (limit) params.limit = String(limit);
    const result = await apiGet('/api/audits', params);
    return { content: [{ type: 'text', text: toText(result) }] };
  },
);

// ── Lock Control ──────────────────────────────────────────────────────────────────

server.registerTool(
  'engage_control_lock',
  {
    description: 'Send a lock control command to a Schlage ENGAGE lock via the connected gateway. Use linkId "all" to control all locks on the gateway simultaneously.',
    inputSchema: {
      gateway_sn: z.string().describe('Gateway serial number (uppercase hex, e.g. "AABBCCDDEEFF0011")'),
      link_id: z.string().describe('Lock linkId from engage_get_access_state, or "all" to target all locks'),
      action: z.enum(['secure', 'passage', 'momentaryUnlock', 'frozenSecure', 'frozenPassage'])
        .describe('secure=locked, passage=unlocked, momentaryUnlock=brief unlock, frozenSecure/frozenPassage=ignore card reads'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  async ({ gateway_sn, link_id, action }) => {
    const result = await apiPost('/api/lock', { gateway_sn, link_id, action });
    return { content: [{ type: 'text', text: toText(result) }] };
  },
);

// ── Access State ──────────────────────────────────────────────────────────────────

server.registerTool(
  'engage_get_access_state',
  {
    description: 'Get the full access control state: all users, schedules, built-in and custom card formats, available locks, and database push statuses.',
    inputSchema: {},
    annotations: { readOnlyHint: true },
  },
  async () => {
    const result = await apiGet('/api/access/state');
    return { content: [{ type: 'text', text: toText(result) }] };
  },
);

// ── Users ──────────────────────────────────────────────────────────────────────

server.registerTool(
  'engage_upsert_user',
  {
    description: 'Create or update a badge user credential. Include "id" to update an existing user. The user is assigned to locks and schedules by their IDs (from engage_get_access_state).',
    inputSchema: {
      id: z.string().optional().describe('Existing user ID to update (omit to create)'),
      usrID: z.number().int().describe('Numeric user ID (must be unique, used in lock database)'),
      name: z.string().optional().describe('Display name for this user'),
      cardNumber: z.string().describe('Card/badge number (decimal string)'),
      facilityCode: z.number().int().optional().describe('Wiegand facility code (if applicable)'),
      issueCode: z.number().int().optional().describe('Issue code (if applicable)'),
      formatSource: z.enum(['builtin', 'custom']).optional().describe('Card format source (default: builtin)'),
      formatId: z.string().optional().describe('Card format ID from engage_get_access_state builtInCardFormats or customCardFormats'),
      scheduleIds: z.array(z.string()).optional().describe('Schedule IDs to assign (defaults to 24x7)'),
      lockIds: z.array(z.string()).describe('Lock linkIds this user can access'),
      adaEn: z.number().int().min(0).max(1).optional().describe('ADA extended unlock: 0=disabled, 1=enabled'),
      fnctn: z.string().optional().describe('User function code (default: "norm")'),
      actDtTm: z.string().optional().describe('Activation datetime YYYYMMDDHHMMSS (default: 20000101000000)'),
      expDtTm: z.string().optional().describe('Expiration datetime YYYYMMDDHHMMSS (default: 20991231235959)'),
    },
    annotations: { readOnlyHint: false },
  },
  async (input) => {
    const result = await apiPost('/api/access/users', input);
    return { content: [{ type: 'text', text: toText(result) }] };
  },
);

server.registerTool(
  'engage_delete_user',
  {
    description: 'Delete a badge user by their ID. Get the ID from engage_get_access_state.',
    inputSchema: {
      id: z.string().describe('User ID to delete (e.g. "user-<uuid>")'),
    },
    annotations: { readOnlyHint: false, destructiveHint: true },
  },
  async ({ id }) => {
    const result = await apiDelete(`/api/access/users/${encodeURIComponent(id)}`);
    return { content: [{ type: 'text', text: toText(result) }] };
  },
);

// ── Schedules ──────────────────────────────────────────────────────────────────

server.registerTool(
  'engage_upsert_schedule',
  {
    description: 'Create or update an access schedule. Schedules define when users are allowed access. Include "id" to update an existing schedule.',
    inputSchema: {
      id: z.string().optional().describe('Existing schedule ID to update (omit to create)'),
      name: z.string().optional().describe('Schedule name'),
      description: z.string().optional().describe('Description'),
      days: z.array(z.enum(['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa']))
        .describe('Days of week (at least one required)'),
      strtHr: z.number().int().min(0).max(23).describe('Start hour (0-23)'),
      strtMn: z.number().int().min(0).max(59).describe('Start minute (0-59)'),
      lngth: z.number().int().min(1).max(1440).describe('Duration in minutes (1-1440)'),
      lockIds: z.array(z.string()).optional().describe('Lock linkIds this schedule applies to'),
    },
    annotations: { readOnlyHint: false },
  },
  async (input) => {
    const result = await apiPost('/api/access/schedules', input);
    return { content: [{ type: 'text', text: toText(result) }] };
  },
);

server.registerTool(
  'engage_delete_schedule',
  {
    description: 'Delete an access schedule. Cannot delete the default 24x7 schedule or schedules assigned to users.',
    inputSchema: {
      id: z.string().describe('Schedule ID to delete (e.g. "schedule-<uuid>")'),
    },
    annotations: { readOnlyHint: false, destructiveHint: true },
  },
  async ({ id }) => {
    const result = await apiDelete(`/api/access/schedules/${encodeURIComponent(id)}`);
    return { content: [{ type: 'text', text: toText(result) }] };
  },
);

// ── Card Formats ──────────────────────────────────────────────────────────────────

server.registerTool(
  'engage_upsert_card_format',
  {
    description: 'Create or update a custom Wiegand card format. Use this to add non-standard card formats not included in the built-in list. Include "id" to update an existing format.',
    inputSchema: {
      id: z.string().optional().describe('Existing format ID to update (omit to create)'),
      name: z.string().describe('Format name (required)'),
      description: z.string().optional().describe('Description'),
      value: z.string().optional().describe('Format value/code (defaults to name)'),
      label: z.string().optional().describe('Display label'),
      fc: z.object({
        min: z.number().int().describe('Minimum facility code'),
        max: z.number().int().describe('Maximum facility code'),
      }).optional().describe('Facility code range constraint'),
      payload: z.object({
        total_card_bits: z.number().int().describe('Total card bits (e.g. 26)'),
        total_cardholder_id_bits: z.number().int().describe('Cardholder ID bits'),
        cardholder_id_start_bit: z.number().int().describe('Start bit for cardholder ID'),
        total_facility_code_bits: z.number().int().optional().describe('Facility code bits'),
        facility_code_start_bit: z.number().int().optional().describe('Start bit for facility code'),
        total_even_parity_bits: z.number().int().optional(),
        even_parity_start_bit: z.number().int().optional(),
        total_odd_parity_bits: z.number().int().optional(),
        odd_parity_start_bit: z.number().int().optional(),
        format: z.string().optional().describe('Format type (default: WIEGAND)'),
        is_corporate_card: z.boolean().optional(),
        is_reverse_card_format: z.boolean().optional(),
      }).describe('Wiegand card format payload'),
    },
    annotations: { readOnlyHint: false },
  },
  async (input) => {
    const result = await apiPost('/api/access/formats', input);
    return { content: [{ type: 'text', text: toText(result) }] };
  },
);

server.registerTool(
  'engage_delete_card_format',
  {
    description: 'Delete a custom card format. Cannot delete formats currently in use by users.',
    inputSchema: {
      id: z.string().describe('Format ID to delete (e.g. "format-<uuid>")'),
    },
    annotations: { readOnlyHint: false, destructiveHint: true },
  },
  async ({ id }) => {
    const result = await apiDelete(`/api/access/formats/${encodeURIComponent(id)}`);
    return { content: [{ type: 'text', text: toText(result) }] };
  },
);

// ── Database Operations ──────────────────────────────────────────────────────────

server.registerTool(
  'engage_preview_database',
  {
    description: 'Preview the credential database payload that would be pushed to a specific lock. Shows all users, schedules, and credentials assigned to that lock without actually pushing.',
    inputSchema: {
      linkId: z.string().describe('Lock linkId (from engage_get_access_state availableLocks)'),
      gateway_sn: z.string().optional().describe('Gateway serial number (optional if only one gateway connected)'),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ linkId, gateway_sn }) => {
    const params: Record<string, string> = {};
    if (gateway_sn) params.gateway_sn = gateway_sn;
    const result = await apiGet(`/api/access/preview/${encodeURIComponent(linkId)}`, params);
    return { content: [{ type: 'text', text: toText(result) }] };
  },
);

server.registerTool(
  'engage_get_lock_status',
  {
    description: 'Get the current live lock status and database transfer status for a specific lock by querying the gateway.',
    inputSchema: {
      linkId: z.string().describe('Lock linkId'),
      gateway_sn: z.string().optional().describe('Gateway serial number'),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ linkId, gateway_sn }) => {
    const params: Record<string, string> = {};
    if (gateway_sn) params.gateway_sn = gateway_sn;
    const result = await apiGet(`/api/access/status/${encodeURIComponent(linkId)}`, params);
    return { content: [{ type: 'text', text: toText(result) }] };
  },
);

server.registerTool(
  'engage_push_database',
  {
    description: 'Push the credential database to a lock. This sends all assigned users and schedules to the lock via the gateway. The lock will store these credentials for offline access control.',
    inputSchema: {
      linkId: z.string().describe('Lock linkId to push credentials to'),
      gateway_sn: z.string().optional().describe('Gateway serial number'),
      overwrite: z.boolean().optional().describe('Overwrite existing database (default false = merge)'),
    },
    annotations: { readOnlyHint: false },
  },
  async ({ linkId, gateway_sn, overwrite }) => {
    const body: Record<string, unknown> = {};
    if (gateway_sn) body.gateway_sn = gateway_sn;
    if (overwrite !== undefined) body.overwrite = overwrite;
    const result = await apiPost(`/api/access/push/${encodeURIComponent(linkId)}`, body);
    return { content: [{ type: 'text', text: toText(result) }] };
  },
);

server.registerTool(
  'engage_pull_database',
  {
    description: 'Pull the current credential database from a lock. Returns the credentials currently stored on the lock.',
    inputSchema: {
      linkId: z.string().describe('Lock linkId'),
      gateway_sn: z.string().optional().describe('Gateway serial number'),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ linkId, gateway_sn }) => {
    const params: Record<string, string> = {};
    if (gateway_sn) params.gateway_sn = gateway_sn;
    const result = await apiGet(`/api/access/pull/${encodeURIComponent(linkId)}`, params);
    return { content: [{ type: 'text', text: toText(result) }] };
  },
);

server.registerTool(
  'engage_clear_database',
  {
    description: 'Clear (wipe) the credential database from a lock. This removes all stored credentials from the lock.',
    inputSchema: {
      linkId: z.string().describe('Lock linkId'),
      gateway_sn: z.string().optional().describe('Gateway serial number'),
    },
    annotations: { readOnlyHint: false, destructiveHint: true },
  },
  async ({ linkId, gateway_sn }) => {
    const body: Record<string, unknown> = {};
    if (gateway_sn) body.gateway_sn = gateway_sn;
    const result = await apiPost(`/api/access/clear/${encodeURIComponent(linkId)}`, body);
    return { content: [{ type: 'text', text: toText(result) }] };
  },
);

// ── Lock Settings ──────────────────────────────────────────────────────────────────

server.registerTool(
  'engage_get_lock_settings',
  {
    description: 'Get current reader and audit settings for a lock (card format support, audit logging, proximity card options, etc.).',
    inputSchema: {
      linkId: z.string().describe('Lock linkId'),
      gateway_sn: z.string().optional().describe('Gateway serial number'),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ linkId, gateway_sn }) => {
    const params: Record<string, string> = {};
    if (gateway_sn) params.gateway_sn = gateway_sn;
    const result = await apiGet(`/api/access/lock-settings/${encodeURIComponent(linkId)}`, params);
    return { content: [{ type: 'text', text: toText(result) }] };
  },
);

server.registerTool(
  'engage_update_lock_settings',
  {
    description: 'Update reader and audit settings for a lock. Common settings: invCrdAudEn (invalid card audit), auditIDEn (audit ID enabled), proxConf* (proximity card format support).',
    inputSchema: {
      linkId: z.string().describe('Lock linkId'),
      gateway_sn: z.string().optional().describe('Gateway serial number'),
      values: z.record(z.union([z.boolean(), z.string(), z.number()]))
        .describe('Key-value settings to update. Boolean keys: invCrdAudEn, auditIDEn, proxConfHID, proxConfGECASI, proxConfAWID, uid14443, mi14443, uid15693, iClsUID40b'),
    },
    annotations: { readOnlyHint: false },
  },
  async ({ linkId, gateway_sn, values }) => {
    const body: Record<string, unknown> = { values };
    if (gateway_sn) body.gateway_sn = gateway_sn;
    const result = await apiPut(`/api/access/lock-settings/${encodeURIComponent(linkId)}`, body);
    return { content: [{ type: 'text', text: toText(result) }] };
  },
);

// ── Enrollment ──────────────────────────────────────────────────────────────────

server.registerTool(
  'engage_get_last_denied',
  {
    description: 'Get the last credential that was denied access at a lock. Useful for enrolling new badges — have the person swipe their card, then call this to get their card data for enrollment.',
    inputSchema: {
      linkId: z.string().describe('Lock linkId'),
      gateway_sn: z.string().optional().describe('Gateway serial number'),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ linkId, gateway_sn }) => {
    const params: Record<string, string> = {};
    if (gateway_sn) params.gateway_sn = gateway_sn;
    const result = await apiGet(`/api/access/last-denied/${encodeURIComponent(linkId)}`, params);
    return { content: [{ type: 'text', text: toText(result) }] };
  },
);

server.registerTool(
  'engage_enroll_swipe',
  {
    description: 'Enroll a new user from a card swipe at a lock. Have the person swipe their badge at the lock, then call this to automatically detect the card data and create a user record.',
    inputSchema: {
      linkId: z.string().describe('Lock linkId where the card was swiped'),
      gateway_sn: z.string().optional().describe('Gateway serial number'),
      usrID: z.number().int().describe('Numeric user ID to assign to the new user'),
      name: z.string().optional().describe('Display name for the new user'),
      lockIds: z.array(z.string()).optional().describe('Lock linkIds to grant access (defaults to the swiped lock)'),
      scheduleIds: z.array(z.string()).optional().describe('Schedule IDs (defaults to 24x7)'),
    },
    annotations: { readOnlyHint: false },
  },
  async ({ linkId, gateway_sn, usrID, name, lockIds, scheduleIds }) => {
    const body: Record<string, unknown> = { usrID };
    if (gateway_sn) body.gateway_sn = gateway_sn;
    if (name) body.name = name;
    if (lockIds) body.lockIds = lockIds;
    if (scheduleIds) body.scheduleIds = scheduleIds;
    const result = await apiPost(`/api/access/enroll-swipe/${encodeURIComponent(linkId)}`, body);
    return { content: [{ type: 'text', text: toText(result) }] };
  },
);

// ── API Playground ──────────────────────────────────────────────────────────────

server.registerTool(
  'engage_playground_send',
  {
    description: 'Send any raw ENGAGE WebSocket API request to a connected gateway. Use this to call any gateway API not covered by the other tools — e.g. GET /gateway/time, GET /edgeDevices/:linkId/time, or any other ENGAGE protocol endpoint. The gateway_sn, method (GET/POST/PUT/DELETE), and path are required.',
    inputSchema: {
      gateway_sn: z.string().describe('Gateway serial number (uppercase hex)'),
      method: z.enum(['GET', 'POST', 'PUT', 'DELETE']).describe('HTTP method'),
      path: z.string().describe('ENGAGE API path, e.g. "/gateway/time" or "/edgeDevices/dev00000/time"'),
      body: z.record(z.unknown()).optional().describe('Request body for POST/PUT requests'),
    },
    annotations: { readOnlyHint: false },
  },
  async ({ gateway_sn, method, path, body }) => {
    const result = await apiPost('/api/playground/send', { gateway_sn, method, path, body });
    return { content: [{ type: 'text', text: toText(result) }] };
  },
);

// ── Start ──────────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
