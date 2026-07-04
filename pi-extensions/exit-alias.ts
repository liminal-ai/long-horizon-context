import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function exitAliasExtension(pi: ExtensionAPI): void {
	pi.registerCommand("exit", {
		description: "Quit pi (alias for /quit)",
		handler: async (_args, ctx) => {
			ctx.shutdown();
		},
	});
}
