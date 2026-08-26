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
	description: "Install dprint, then check source formatting";
	author: "kjanat";
	inputs: Readonly<{
		"dprint-version": ActionInput<"latest">;
		token: ActionInput<"${{ github.token }}">;
		"config-path": ActionInput<"">;
		args: ActionInput<"">;
	}>;
	outputs: Readonly<{
		version: JavaScriptActionOutput;
		location: JavaScriptActionOutput;
	}>;
	runs: Readonly<{
		using: "node24";
		main: "dist/main.mjs";
		pre?: string;
		"pre-if"?: string;
	}>;
	branding: Readonly<{
		icon: "check-circle";
		color: "gray-dark";
	}>;
}>;

export default action;
