import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const STATUS_ID = "self-status-line";

export default function selfStatusLine(pi: ExtensionAPI): void {
	let enabled = true;
	let running = false;
	let turnCount = 0;
	let toolCount = 0;
	let lastTool: string | undefined;

	function modelLabel(ctx: ExtensionContext): string {
		const model = ctx.model;
		if (!model) return "no model";
		return model.id;
	}

	function update(ctx: ExtensionContext): void {
		if (!enabled) {
			ctx.ui.setStatus(STATUS_ID, undefined);
			return;
		}

		const theme = ctx.ui.theme;
		const piIcon = theme.fg("accent", "π");
		const state = running ? theme.fg("warning", "working") : theme.fg("success", "idle");
		const model = theme.fg("dim", modelLabel(ctx));
		const thinking = ctx.thinkingLevel ? theme.fg("dim", `:${ctx.thinkingLevel}`) : "";
		const progress = running
			? theme.fg("dim", ` t${turnCount}${toolCount ? ` tools:${toolCount}` : ""}${lastTool ? ` ${lastTool}` : ""}`)
			: theme.fg("dim", ` t${turnCount}`);

		ctx.ui.setStatus(STATUS_ID, `${piIcon} ${state} ${model}${thinking}${progress}`);
	}

	pi.registerCommand("self-status", {
		description: "Toggle Pi self status line (on/off/status)",
		handler: async (args, ctx) => {
			const arg = (args ?? "").trim().toLowerCase();
			if (["off", "disable", "disabled"].includes(arg)) enabled = false;
			else if (["on", "enable", "enabled"].includes(arg)) enabled = true;
			else if (arg && !["status", "?"].includes(arg)) {
				ctx.ui.notify("Usage: /self-status [on|off|status]", "info");
				return;
			}

			update(ctx);
			ctx.ui.notify(`Self status line is ${enabled ? "on" : "off"}.`, "info");
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		turnCount = ctx.sessionManager
			.getBranch()
			.filter((entry) => entry.type === "message" && entry.message.role === "assistant").length;
		toolCount = 0;
		lastTool = undefined;
		running = !ctx.isIdle();
		update(ctx);
	});

	pi.on("agent_start", async (_event, ctx) => {
		running = true;
		toolCount = 0;
		lastTool = undefined;
		update(ctx);
	});

	pi.on("turn_start", async (_event, ctx) => {
		turnCount++;
		toolCount = 0;
		lastTool = undefined;
		update(ctx);
	});

	pi.on("tool_execution_start", async (event, ctx) => {
		toolCount++;
		lastTool = event.toolName;
		update(ctx);
	});

	pi.on("agent_settled", async (_event, ctx) => {
		running = false;
		lastTool = undefined;
		update(ctx);
	});

	pi.on("model_select", async (_event, ctx) => update(ctx));
	pi.on("thinking_level_select", async (_event, ctx) => update(ctx));
	pi.on("session_info_changed", async (_event, ctx) => update(ctx));
	pi.on("session_tree", async (_event, ctx) => update(ctx));
}
