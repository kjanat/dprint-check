import { randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
import { EOL } from "node:os";
import { delimiter } from "node:path";
import { env } from "node:process";

interface InputOptions {
	trimWhitespace?: boolean;
}

function escapeData(value: string): string {
	return value.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");
}

function escapeProperty(value: string): string {
	return escapeData(value).replaceAll(":", "%3A").replaceAll(",", "%2C");
}

function command(name: string, value: string, properties: Record<string, string> = {}): void {
	const serialized = Object.entries(properties).map(([key, property]) => `${key}=${escapeProperty(property)}`).join(
		",",
	);
	process.stdout.write(`::${name}${serialized === "" ? "" : ` ${serialized}`}::${escapeData(value)}${EOL}`);
}

function fileCommand(variable: string, name: string, value: string): boolean {
	const path = env[variable];
	if (path === undefined || path === "") return false;
	const marker = `dprint_${randomUUID()}`;
	if (value.includes(marker)) throw new Error(`Unable to write ${name}: value contains generated delimiter`);
	appendFileSync(path, `${name}<<${marker}${EOL}${value}${EOL}${marker}${EOL}`, { encoding: "utf8" });
	return true;
}

export function getInput(name: string, options: InputOptions = {}): string {
	const value = env[`INPUT_${name.replaceAll(" ", "_").toUpperCase()}`] ?? "";
	return options.trimWhitespace === false ? value : value.trim();
}

export function setSecret(secret: string): void {
	command("add-mask", secret);
}

export function debug(message: string): void {
	command("debug", message);
}

export function info(message: string): void {
	process.stdout.write(`${message}${EOL}`);
}

export function warning(message: string): void {
	command("warning", message);
}

export function setFailed(message: string): void {
	process.exitCode = 1;
	command("error", message);
}

export function setOutput(name: string, value: string | boolean): void {
	const serialized = String(value);
	if (!fileCommand("GITHUB_OUTPUT", name, serialized)) command("set-output", serialized, { name });
}

export function saveState(name: string, value: string): void {
	if (!fileCommand("GITHUB_STATE", name, value)) command("save-state", value, { name });
}

export function getState(name: string): string {
	return env[`STATE_${name}`] ?? "";
}

export function exportVariable(name: string, value: string): void {
	env[name] = value;
	if (!fileCommand("GITHUB_ENV", name, value)) command("set-env", value, { name });
}

export function addPath(path: string): void {
	env["PATH"] = `${path}${delimiter}${env["PATH"] ?? ""}`;
	const file = env["GITHUB_PATH"];
	if (file !== undefined && file !== "") appendFileSync(file, `${path}${EOL}`, { encoding: "utf8" });
	else command("add-path", path);
}
