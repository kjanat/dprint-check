type ActionInput<Default extends string> = Readonly<{
	description: string;
	required: false;
	default: Default;
	deprecationMessage?: string;
}>;

type JavaScriptActionOutput = Readonly<{
	description: string;
}>;

declare const action: Readonly<{
	name: "dprint-check-action";
	description: "Install dprint with caching, then check source formatting";
	author: "thomaseizinger";
	inputs: Readonly<{
		"dprint-version": ActionInput<"latest">;
		token: ActionInput<"${{ github.token }}">;
		cache: ActionInput<"true">;
		"install-only": ActionInput<"false">;
		"config-path": ActionInput<"">;
		args: ActionInput<"">;
	}>;
	outputs: Readonly<{
		version: JavaScriptActionOutput;
		location: JavaScriptActionOutput;
		"cache-hit": JavaScriptActionOutput;
		"plugin-cache-hit": JavaScriptActionOutput;
		"plugin-cache-key": JavaScriptActionOutput;
	}>;
	runs: Readonly<{
		using: "node24";
		main: "dist/main.mjs";
		pre?: string;
		"pre-if"?: string;
		post: "dist/post.mjs";
		"post-if": "always()";
	}>;
	branding: Readonly<{
		icon: "check-circle";
		color: "gray-dark";
	}>;
}>;

export default action;
