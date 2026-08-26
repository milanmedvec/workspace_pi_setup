import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

type Totals = {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	cost: number;
};

type LimitConfig = {
	mode?: "cost" | "tokens";
	cost?: { fiveHour?: number; week?: number; "5h"?: number; "7d"?: number };
	tokens?: { fiveHour?: number; week?: number; "5h"?: number; "7d"?: number };
};

type SubscriptionWindow = {
	label: string;
	usedPercent: number;
	windowMinutes?: number;
	resetsAt?: number;
};

type SubscriptionLimits = {
	planType?: string;
	primary?: SubscriptionWindow;
	secondary?: SubscriptionWindow;
	resetCredits?: number;
	updatedAt: number;
	error?: string;
};

const EMPTY_TOTALS: Totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 };
const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const CONFIG_DIR = process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".pi", "agent");
const SESSION_DIR = process.env.PI_CODING_AGENT_SESSION_DIR ?? path.join(CONFIG_DIR, "sessions");
const LIMITS_PATH = path.join(CONFIG_DIR, "usage-limits.json");

function addUsage(totals: Totals, usage: any): void {
	if (!usage) return;
	totals.input += Number(usage.input) || 0;
	totals.output += Number(usage.output) || 0;
	totals.cacheRead += Number(usage.cacheRead) || 0;
	totals.cacheWrite += Number(usage.cacheWrite) || 0;
	totals.totalTokens += Number(usage.totalTokens) || 0;
	totals.cost += Number(usage.cost?.total) || 0;
}

function cloneTotals(totals: Totals): Totals {
	return { ...totals };
}

function formatTokens(count: number): string {
	if (count < 1000) return `${Math.round(count)}`;
	if (count < 10_000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1_000_000) return `${Math.round(count / 1000)}k`;
	if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
	return `${Math.round(count / 1_000_000)}M`;
}

function formatMoney(value: number): string {
	return value < 10 ? `$${value.toFixed(2)}` : `$${value.toFixed(1)}`;
}

function parseQuantity(value: string): number {
	const match = value.trim().match(/^(\d+(?:\.\d+)?)([kKmM])?$/);
	if (!match) return Number(value);
	const base = Number(match[1]);
	const suffix = match[2]?.toLowerCase();
	if (suffix === "k") return base * 1_000;
	if (suffix === "m") return base * 1_000_000;
	return base;
}

function compactCwd(cwd: string): string {
	const home = os.homedir();
	if (cwd === home) return "~";
	if (cwd.startsWith(`${home}${path.sep}`)) return `~${path.sep}${path.relative(home, cwd)}`;
	return cwd;
}

function pctColor(ctx: ExtensionContext, pct: number, text: string): string {
	if (pct >= 95) return ctx.ui.theme.fg("error", text);
	if (pct >= 80) return ctx.ui.theme.fg("warning", text);
	if (pct >= 60) return ctx.ui.theme.fg("accent", text);
	return ctx.ui.theme.fg("success", text);
}

function bar(ctx: ExtensionContext, pct: number, width = 5): string {
	const filled = Math.max(0, Math.min(width, Math.round((pct / 100) * width)));
	const raw = "▰".repeat(filled) + "▱".repeat(width - filled);
	return pctColor(ctx, pct, raw);
}

function getLimit(config: LimitConfig, mode: "cost" | "tokens", window: "fiveHour" | "week"): number | undefined {
	const bucket = config[mode] ?? {};
	const shorthand = window === "fiveHour" ? "5h" : "7d";
	const value = bucket[window] ?? bucket[shorthand];
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function usageWindow(ctx: ExtensionContext, label: string, totals: Totals, config: LimitConfig): string {
	const mode = config.mode ?? "cost";
	const window = label === "5h" ? "fiveHour" : "week";
	const used = mode === "tokens" ? totals.totalTokens : totals.cost;
	const limit = getLimit(config, mode, window);
	const usedText = mode === "tokens" ? formatTokens(used) : formatMoney(used);
	if (!limit) return ctx.ui.theme.fg("dim", `${label} ${usedText}/—`);

	const pct = Math.min(999, (used / limit) * 100);
	const limitText = mode === "tokens" ? formatTokens(limit) : formatMoney(limit);
	return `${ctx.ui.theme.fg("dim", `${label} `)}${bar(ctx, pct)} ${pctColor(ctx, pct, `${usedText}/${limitText}`)}`;
}

function formatReset(resetsAt?: number): string {
	if (!resetsAt) return "";
	const minutes = Math.max(0, Math.round((resetsAt * 1000 - Date.now()) / 60_000));
	if (minutes >= 24 * 60) return ` ↻${Math.round(minutes / (24 * 60))}d`;
	if (minutes >= 60) return ` ↻${Math.round(minutes / 60)}h`;
	return ` ↻${minutes}m`;
}

function subscriptionUsageWindow(ctx: ExtensionContext, label: string, window: SubscriptionWindow | undefined): string | undefined {
	if (!window) return undefined;
	const pct = Math.max(0, Math.min(999, window.usedPercent));
	return `${ctx.ui.theme.fg("dim", `${label} `)}${bar(ctx, pct)} ${pctColor(ctx, pct, `${pct.toFixed(0)}%${formatReset(window.resetsAt)}`)}`;
}

function rollingCostWindow(ctx: ExtensionContext, label: string, totals: Totals): string {
	return ctx.ui.theme.fg("dim", `${label}$ ${formatMoney(totals.cost)}`);
}

function decodeJwtPayload(token: string): any | undefined {
	try {
		const payload = token.split(".")[1];
		if (!payload) return undefined;
		return JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
	} catch {
		return undefined;
	}
}

function extractChatGptAccountId(token: string): string | undefined {
	const payload = decodeJwtPayload(token);
	const id = payload?.["https://api.openai.com/auth"]?.chatgpt_account_id;
	return typeof id === "string" && id.length > 0 ? id : undefined;
}

function normalizeChatGptBaseUrl(raw: string | undefined): string {
	let base = (raw || "https://chatgpt.com/backend-api").replace(/\/+$/, "");
	base = base.replace(/\/codex\/responses$/, "").replace(/\/codex$/, "");
	return base;
}

function labelForWindow(window: any): string {
	const minutes = Number(window?.limit_window_seconds) / 60;
	if (minutes > 0) {
		if (Math.abs(minutes - 300) <= 30) return "5h";
		if (Math.abs(minutes - 10_080) <= 120) return "7d";
		if (Math.abs(minutes - 1_440) <= 60) return "1d";
		if (Math.abs(minutes - 43_200) <= 1_440) return "30d";
		if (minutes < 180) return `${Math.round(minutes)}m`;
		if (minutes < 48 * 60) return `${Math.round(minutes / 60)}h`;
		return `${Math.round(minutes / 1_440)}d`;
	}
	return "limit";
}

function toSubscriptionWindow(raw: any, fallbackLabel?: string): SubscriptionWindow | undefined {
	if (!raw) return undefined;
	const inferredLabel = labelForWindow(raw);
	return {
		label: inferredLabel === "limit" && fallbackLabel ? fallbackLabel : inferredLabel,
		usedPercent: Number(raw.used_percent ?? raw.usedPercent) || 0,
		windowMinutes: raw.limit_window_seconds ? Math.round(Number(raw.limit_window_seconds) / 60) : raw.windowDurationMins,
		resetsAt: Number(raw.reset_at ?? raw.resetsAt) || undefined,
	};
}

function pickSubscriptionWindows(payload: any): { primary?: SubscriptionWindow; secondary?: SubscriptionWindow } {
	const windows: SubscriptionWindow[] = [];
	const main = payload?.rate_limit;
	const mainPrimary = toSubscriptionWindow(main?.primary_window, "5h");
	const mainSecondary = toSubscriptionWindow(main?.secondary_window, "7d");
	for (const window of [mainPrimary, mainSecondary]) {
		if (window) windows.push(window);
	}
	for (const additional of payload?.additional_rate_limits ?? []) {
		const rateLimit = additional?.rate_limit;
		for (const raw of [rateLimit?.primary_window, rateLimit?.secondary_window]) {
			const window = toSubscriptionWindow(raw, additional?.limit_name || additional?.metered_feature);
			if (window) windows.push(window);
		}
	}

	// Codex exposes these as primary/secondary windows; treat them as the footer's
	// 5h/7d slots even when the backend reports a generic or surprising duration.
	const fiveHour = mainPrimary ?? windows.find((w) => w.label === "5h") ?? windows[0];
	const week = mainSecondary ?? windows.find((w) => w.label === "7d") ?? windows.find((w) => w !== fiveHour) ?? fiveHour;
	return { primary: fiveHour, secondary: week };
}

async function fetchSubscriptionLimits(ctx: ExtensionContext): Promise<SubscriptionLimits | undefined> {
	if (ctx.model?.provider !== "openai-codex") return undefined;
	const auth = await ctx.modelRegistry.getProviderAuth("openai-codex");
	const token = auth?.auth.apiKey;
	if (!token) return { updatedAt: Date.now(), error: "no auth" };
	const accountId = extractChatGptAccountId(token);
	if (!accountId) return { updatedAt: Date.now(), error: "no account" };

	const baseUrl = normalizeChatGptBaseUrl(auth.auth.baseUrl ?? ctx.model.baseUrl);
	const response = await fetch(`${baseUrl}/wham/usage`, {
		headers: {
			Authorization: `Bearer ${token}`,
			"ChatGPT-Account-Id": accountId,
			"User-Agent": "pi-fancy-footer",
		},
	});
	if (!response.ok) return { updatedAt: Date.now(), error: `${response.status}` };
	const payload = await response.json();
	const windows = pickSubscriptionWindows(payload);
	return {
		planType: typeof payload?.plan_type === "string" ? payload.plan_type : undefined,
		...windows,
		resetCredits: typeof payload?.rate_limit_reset_credits?.available_count === "number" ? payload.rate_limit_reset_credits.available_count : undefined,
		updatedAt: Date.now(),
	};
}

async function readLimitConfig(): Promise<LimitConfig> {
	try {
		const raw = await fs.readFile(LIMITS_PATH, "utf8");
		return JSON.parse(raw) as LimitConfig;
	} catch {
		return { mode: "cost", cost: {}, tokens: {} };
	}
}

async function writeLimitConfig(config: LimitConfig): Promise<void> {
	await fs.mkdir(CONFIG_DIR, { recursive: true });
	await fs.writeFile(LIMITS_PATH, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

async function* walkFiles(dir: string): AsyncGenerator<string> {
	let entries: any[];
	try {
		entries = await fs.readdir(dir, { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) yield* walkFiles(full);
		else if (entry.isFile() && entry.name.endsWith(".jsonl")) yield full;
	}
}

async function scanRollingUsage(provider: string | undefined): Promise<{ fiveHour: Totals; week: Totals }> {
	const now = Date.now();
	const fiveHour = cloneTotals(EMPTY_TOTALS);
	const week = cloneTotals(EMPTY_TOTALS);
	if (!provider) return { fiveHour, week };

	for await (const file of walkFiles(SESSION_DIR)) {
		let raw: string;
		try {
			raw = await fs.readFile(file, "utf8");
		} catch {
			continue;
		}
		for (const line of raw.split("\n")) {
			if (!line.trim()) continue;
			let entry: any;
			try {
				entry = JSON.parse(line);
			} catch {
				continue;
			}
			if (entry.type !== "message" || entry.message?.role !== "assistant") continue;
			if (entry.message.provider !== provider) continue;
			const timestamp = Number(entry.message.timestamp ?? Date.parse(entry.timestamp));
			if (!Number.isFinite(timestamp) || now - timestamp > WEEK_MS) continue;
			addUsage(week, entry.message.usage);
			if (now - timestamp <= FIVE_HOURS_MS) addUsage(fiveHour, entry.message.usage);
		}
	}
	return { fiveHour, week };
}

function currentSessionTotals(ctx: ExtensionContext): { totals: Totals; latestCacheHit?: number } {
	const totals = cloneTotals(EMPTY_TOTALS);
	let latestCacheHit: number | undefined;
	for (const entry of ctx.sessionManager.getEntries()) {
		const message = (entry as any).message;
		if (entry.type === "message" && message?.usage) {
			addUsage(totals, message.usage);
			if (message.role === "assistant") {
				const prompt = (Number(message.usage.input) || 0) + (Number(message.usage.cacheRead) || 0) + (Number(message.usage.cacheWrite) || 0);
				latestCacheHit = prompt > 0 ? ((Number(message.usage.cacheRead) || 0) / prompt) * 100 : undefined;
			}
		} else if ((entry.type === "branch_summary" || entry.type === "compaction") && (entry as any).usage) {
			addUsage(totals, (entry as any).usage);
		}
	}
	return { totals, latestCacheHit };
}

export default function fancyFooter(pi: ExtensionAPI): void {
	let enabled = true;
	let running = false;
	let lastTool: string | undefined;
	let config: LimitConfig = { mode: "cost", cost: {}, tokens: {} };
	let rolling = { fiveHour: cloneTotals(EMPTY_TOTALS), week: cloneTotals(EMPTY_TOTALS), updatedAt: 0 };
	let subscriptionLimits: SubscriptionLimits | undefined;
	let scanInFlight = false;
	let activeTui: { requestRender(): void } | undefined;

	async function refreshRolling(ctx: ExtensionContext): Promise<void> {
		if (scanInFlight) return;
		scanInFlight = true;
		try {
			config = await readLimitConfig();
			const [result, remoteLimits] = await Promise.all([
				scanRollingUsage(ctx.model?.provider),
				fetchSubscriptionLimits(ctx).catch((error) => ({
					updatedAt: Date.now(),
					error: error instanceof Error ? error.message : String(error),
				})),
			]);
			rolling = { ...result, updatedAt: Date.now() };
			subscriptionLimits = remoteLimits;
			activeTui?.requestRender();
		} finally {
			scanInFlight = false;
		}
	}

	function installFooter(ctx: ExtensionContext): void {
		if (!enabled) {
			ctx.ui.setFooter(undefined);
			return;
		}

		ctx.ui.setFooter((tui, theme, footerData) => {
			activeTui = tui;
			const unsub = footerData.onBranchChange(() => tui.requestRender());
			return {
				dispose: () => {
					unsub();
					if (activeTui === tui) activeTui = undefined;
				},
				invalidate() {},
				render(width: number): string[] {
					const { totals, latestCacheHit } = currentSessionTotals(ctx);
					const usage = ctx.getContextUsage();
					const contextWindow = usage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
					const contextPct = usage?.percent ?? 0;
					const branch = footerData.getGitBranch();
					const sessionName = ctx.sessionManager.getSessionName();

					const cwdPart = compactCwd(ctx.cwd);
					const topBits = [theme.fg("accent", "π"), theme.fg("dim", cwdPart)];
					if (branch) topBits.push(theme.fg("muted", ` ${branch}`));
					if (sessionName) topBits.push(theme.fg("muted", `◆ ${sessionName}`));
					const statuses = Array.from(footerData.getExtensionStatuses().entries())
						.filter(([key]) => key !== "self-status-line")
						.map(([, text]) => text.replace(/[\r\n\t]/g, " ").trim())
						.filter(Boolean);
					if (statuses.length) topBits.push(theme.fg("warning", statuses.join(" ")));

					const cacheHit = latestCacheHit !== undefined ? ` CH${latestCacheHit.toFixed(1)}%` : "";
					const tokenBits = `↑${formatTokens(totals.input)} ↓${formatTokens(totals.output)} R${formatTokens(totals.cacheRead)}${cacheHit}`;
					const sub = ctx.model?.provider && ["openai-codex", "anthropic", "github-copilot", "kimi-coding"].includes(ctx.model.provider) ? " sub" : "";
					const contextText = contextWindow ? `${contextPct.toFixed(1)}%/${formatTokens(contextWindow)}` : "ctx ?";
					const contextStyled = pctColor(ctx, contextPct, contextText);
					const state = running ? theme.fg("warning", `● ${lastTool ?? "working"}`) : theme.fg("success", "● idle");
					const fiveHourUsage =
						subscriptionUsageWindow(ctx, "5h", subscriptionLimits?.primary) ??
						usageWindow(ctx, "5h", rolling.fiveHour, config);
					const weekUsage =
						subscriptionUsageWindow(ctx, "7d", subscriptionLimits?.secondary) ??
						usageWindow(ctx, "7d", rolling.week, config);
					const planBits = [
						subscriptionLimits?.planType,
						subscriptionLimits?.resetCredits ? `reset×${subscriptionLimits.resetCredits}` : undefined,
					]
						.filter(Boolean)
						.join(" ");
					const left = [
						theme.fg("dim", tokenBits),
						theme.fg("dim", `session ${formatMoney(totals.cost)}${sub}`),
						rollingCostWindow(ctx, "5h", rolling.fiveHour),
						rollingCostWindow(ctx, "7d", rolling.week),
						fiveHourUsage,
						weekUsage,
						planBits ? theme.fg("muted", planBits) : undefined,
						contextStyled,
						state,
					].filter(Boolean).join(theme.fg("dim", " │ "));

					const model = ctx.model ? `${ctx.model.id}${ctx.thinkingLevel ? ` • ${ctx.thinkingLevel}` : ""}` : "no model";
					const right = theme.fg("dim", model);
					let statsLine: string;
					const leftWidth = visibleWidth(left);
					const rightWidth = visibleWidth(right);
					if (leftWidth + rightWidth + 2 <= width) {
						statsLine = left + " ".repeat(width - leftWidth - rightWidth) + right;
					} else {
						const available = Math.max(0, width - rightWidth - 2);
						const shortLeft = truncateToWidth(left, available, theme.fg("dim", "…"));
						statsLine = `${shortLeft}  ${right}`;
						statsLine = truncateToWidth(statsLine, width, theme.fg("dim", "…"));
					}

					return [
						truncateToWidth(topBits.join(theme.fg("dim", "  ")), width, theme.fg("dim", "…")),
						statsLine,
					];
				},
			};
		});
	}

	pi.registerCommand("fancy-footer", {
		description: "Toggle the fancy footer (on/off/status)",
		handler: async (args, ctx) => {
			const arg = (args ?? "").trim().toLowerCase();
			if (["off", "disable"].includes(arg)) enabled = false;
			else if (["on", "enable"].includes(arg)) enabled = true;
			installFooter(ctx);
			ctx.ui.notify(`Fancy footer is ${enabled ? "on" : "off"}.`, "info");
		},
	});

	pi.registerCommand("usage-limits", {
		description: "Show/set rolling footer limits, e.g. /usage-limits 5h=2 week=10 mode=cost",
		handler: async (args, ctx) => {
			const text = (args ?? "").trim();
			config = await readLimitConfig();
			if (text) {
				for (const part of text.split(/\s+/)) {
					const [rawKey, rawValue] = part.split("=", 2);
					const key = rawKey?.toLowerCase();
					if (!key || rawValue === undefined) continue;
					if (key === "mode" && (rawValue === "cost" || rawValue === "tokens")) config.mode = rawValue;
					const mode = config.mode ?? "cost";
					if (["5h", "fivehour"].includes(key)) {
						config[mode] ??= {};
						(config[mode] as any).fiveHour = parseQuantity(rawValue);
					}
					if (["week", "7d", "weekly"].includes(key)) {
						config[mode] ??= {};
						(config[mode] as any).week = parseQuantity(rawValue);
					}
				}
				await writeLimitConfig(config);
				void refreshRolling(ctx);
			}
			const mode = config.mode ?? "cost";
			ctx.ui.notify(
				`Usage limits (${mode}): 5h=${getLimit(config, mode, "fiveHour") ?? "—"}, week=${getLimit(config, mode, "week") ?? "—"}. Config: ${LIMITS_PATH}`,
				"info",
			);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		installFooter(ctx);
		void refreshRolling(ctx);
	});
	pi.on("agent_start", async (_event, ctx) => {
		running = true;
		lastTool = undefined;
		activeTui?.requestRender();
		installFooter(ctx);
	});
	pi.on("tool_execution_start", async (event) => {
		lastTool = event.toolName;
		activeTui?.requestRender();
	});
	pi.on("agent_settled", async (_event, ctx) => {
		running = false;
		lastTool = undefined;
		activeTui?.requestRender();
		void refreshRolling(ctx);
	});
	pi.on("model_select", async (_event, ctx) => void refreshRolling(ctx));
	pi.on("thinking_level_select", async () => activeTui?.requestRender());
	pi.on("session_info_changed", async () => activeTui?.requestRender());
	pi.on("session_tree", async (_event, ctx) => {
		activeTui?.requestRender();
		void refreshRolling(ctx);
	});
	pi.on("session_shutdown", async (_event, ctx) => ctx.ui.setFooter(undefined));
}
