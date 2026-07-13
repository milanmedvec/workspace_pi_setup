import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

interface PlanModeState {
	enabled: boolean;
	previousTools?: string[];
}

const STATE_TYPE = "plan-mode-state";
const STATUS_ID = "plan-mode";
const READ_ONLY_TOOLS = ["read", "grep", "find", "ls"];

const PLAN_MODE_PROMPT = `
## PLAN MODE ACTIVE

You are in plan mode.

Your goal is to discuss, analyze, ask clarifying questions, and plan implementation. Do not modify anything.

Rules:
- Do not modify files or create files.
- Do not run commands that modify files, dependencies, Git state, services, processes, or system configuration.
- Do not use mutation-capable tools such as edit, write, or bash.
- Use read-only inspection tools only when necessary.
- Focus on understanding the request, identifying risks and tradeoffs, and proposing a clear implementation plan.
- If the user asks you to implement while plan mode is active, explain what you would change instead of making the change.
`;

export default function planModeExtension(pi: ExtensionAPI): void {
	let enabled = false;
	let previousTools: string[] | undefined;
	let toolsRestricted = false;

	function persistState(): void {
		pi.appendEntry<PlanModeState>(STATE_TYPE, {
			enabled,
			previousTools,
		});
	}

	function restoreState(ctx: ExtensionContext): void {
		const latest = [...ctx.sessionManager.getBranch()]
			.reverse()
			.find((entry) => entry.type === "custom" && entry.customType === STATE_TYPE) as
			| { data?: PlanModeState }
			| undefined;

		enabled = latest?.data?.enabled ?? false;
		previousTools = latest?.data?.previousTools;
	}

	function applyMode(ctx: ExtensionContext): void {
		if (enabled) {
			pi.setActiveTools(READ_ONLY_TOOLS);
			toolsRestricted = true;
			ctx.ui.setStatus(STATUS_ID, ctx.ui.theme.fg("warning", "PLAN"));
		} else {
			if (toolsRestricted) {
				pi.setActiveTools(previousTools ?? pi.getAllTools().map((tool) => tool.name));
				toolsRestricted = false;
			}
			ctx.ui.setStatus(STATUS_ID, undefined);
		}
	}

	function setPlanMode(ctx: ExtensionContext, nextEnabled: boolean): void {
		if (nextEnabled === enabled) {
			applyMode(ctx);
			ctx.ui.notify(`Plan mode is already ${enabled ? "enabled" : "disabled"}.`, "info");
			return;
		}

		if (nextEnabled) {
			previousTools = pi.getActiveTools();
			enabled = true;
			pi.setActiveTools(READ_ONLY_TOOLS);
			ctx.ui.notify("Plan mode enabled: read-only analysis and planning only.", "info");
		} else {
			enabled = false;
			ctx.ui.notify("Plan mode disabled: previous tools restored.", "info");
		}

		applyMode(ctx);
		if (!enabled) previousTools = undefined;
		persistState();
	}

	function togglePlanMode(ctx: ExtensionContext): void {
		setPlanMode(ctx, !enabled);
	}

	pi.registerCommand("plan", {
		description: "Toggle plan mode (read-only analysis and planning)",
		handler: async (args, ctx) => {
			const arg = (args ?? "").trim().toLowerCase();
			if (["on", "enable", "enabled"].includes(arg)) {
				setPlanMode(ctx, true);
			} else if (["off", "disable", "disabled"].includes(arg)) {
				setPlanMode(ctx, false);
			} else if (["status", "?"].includes(arg)) {
				applyMode(ctx);
				ctx.ui.notify(`Plan mode is ${enabled ? "enabled" : "disabled"}.`, "info");
			} else {
				togglePlanMode(ctx);
			}
		},
	});

	pi.registerShortcut("ctrl+alt+p", {
		description: "Toggle plan mode",
		handler: async (ctx) => togglePlanMode(ctx),
	});

	pi.on("session_start", async (_event, ctx) => {
		restoreState(ctx);
		applyMode(ctx);
	});

	pi.on("session_tree", async (_event, ctx) => {
		restoreState(ctx);
		applyMode(ctx);
	});

	pi.on("before_agent_start", async (event) => {
		if (!enabled) return undefined;

		return {
			systemPrompt: `${event.systemPrompt}\n${PLAN_MODE_PROMPT}`,
		};
	});

	pi.on("tool_call", async (event) => {
		if (!enabled) return undefined;

		if (!READ_ONLY_TOOLS.includes(event.toolName)) {
			return {
				block: true,
				reason: `Plan mode is active: tool '${event.toolName}' is disabled because it may modify the workspace. Use /plan to leave plan mode.`,
			};
		}

		return undefined;
	});
}
