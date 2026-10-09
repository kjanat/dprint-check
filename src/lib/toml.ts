import { getStaticTOMLValue, parseTOML, traverseNodes } from "toml-eslint-parser";

/** Preserve the fork's TOML values when materializing a configuration as JSON. */
export function parseTomlConfig(text: string): Record<string, unknown> {
	const ast = parseTOML(text, { tomlVersion: "1.1" });
	const dates = new Map<Date, string>();
	traverseNodes(ast, {
		enterNode(node) {
			if (node.type !== "TOMLValue") return;
			if (node.kind === "float") throw new Error(`Expected a signed integer, got ${node.number}`);
			if (node.kind === "integer" && (node.bigint < -2147483648n || node.bigint > 2147483647n)) {
				throw new Error(`Integer is outside the signed 32-bit range: ${node.number}`);
			}
			if (node.value instanceof Date && "datetime" in node) {
				dates.set(node.value, node.datetime.replace(/^(\d{4}-\d{2}-\d{2})[ t]/u, "$1T").replace(/z$/u, "Z"));
			}
		},
		leaveNode() {},
	});
	const normalize = (value: unknown): unknown => {
		if (value instanceof Date) {
			const text = dates.get(value);
			if (text === undefined) throw new Error("Missing TOML datetime source");
			return text;
		}
		if (Array.isArray(value)) return value.map(normalize);
		if (value !== null && typeof value === "object") {
			return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, normalize(item)]));
		}
		return value;
	};
	return Object.fromEntries(Object.entries(getStaticTOMLValue(ast)).map(([key, value]) => [key, normalize(value)]));
}
